
import { createApp, ref, computed, watch, onMounted, nextTick, reactive } from './vendor/vue-3.5.13.esm-browser.prod.js'

// Firebase 設定改由外部檔案提供：自架者請編輯 firebase-config.js
import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDocs, runTransaction, deleteField, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { CHECKLIST_CATEGORIES, LUGGAGE_META, CHECKLIST_TEMPLATE } from './checklist-data.js';
import { ASA_SD_2026_TRIP_DEFAULTS, ASA_SD_2026_ITINERARY, ASA_SD_2026_POSTER, ASA_SD_2026_FLIGHTS, ASA_SD_2026_BOOKINGS } from './asa-trip-template.js';

const app = createApp({
    setup() {
        console.log('Vue Setup started');
        const viewMode = ref('plan');
        const currentDayIdx = ref(0);
        const amountInputRef = ref(null);
        const isAmountInvalid = ref(false);
        const weatherInputRef = ref(null);

        const showTripMenu = ref(false);
        const tripList = ref([]);
        const currentTripId = ref(null);
        const showSetupModal = ref(false);
        const isEditing = ref(false);
        const isDataLoading = ref(false);
        const isLoggedIn = ref(false);
        const dbError = ref(false);
        const dbErrorCode = ref('');
        const syncStatus = ref('synced');
        const shareUrl = ref('');
        const showShareModal = ref(false);
        const showJoinInput = ref(false);
        const joinTripUrl = ref('');

        const errorMap = {
            'unavailable': '無法連線到伺服器，請檢查網路。',
            'permission-denied': '存取被拒絕，請確認您有權限。',
            'not-found': '找不到此行程，可能已被刪除。',
            'resource-exhausted': '配額已滿，請稍後再試。',
            'not-configured': '尚未設定 Firebase：請編輯 firebase-config.js，填入你自己的 Firebase 專案設定（步驟見 README）。',
            'auth-failed': '匿名登入失敗，請確認 Firebase Console → Authentication → Sign-in method 已啟用「匿名」。'
        };

        const dbErrorMessage = computed(() => errorMap[dbErrorCode.value] || `發生未知錯誤 (${dbErrorCode.value})`);

        let db = null;
        let auth = null;
        let unsubscribeTripData = null;
        let ignoreRemoteUpdate = false;

        const editingState = reactive({ dayTitle: false, flight: false });

        const days = ref([]);
        const savedLocations = ref([]);
        // expenses 是 trips/{tripId}/expenses 子集合的即時鏡像（見 subscribeExpenses），
        // 不再是存在 trip 文件裡的陣列欄位——原因見下方「記帳」區塊開頭的說明
        const expenses = ref([]);
        const checklist = ref([]);
        // 使用者自己加的分類（例如「購物清單」）——跟內建的 CHECKLIST_CATEGORIES 分開存，
        // 這樣以後改版更新內建分類清單時不會跟使用者自訂的混在一起、也不會互相覆蓋
        const customChecklistCategories = ref([]);
        const bookings = ref([]); // 訂位/票券總表：hotel / flight / restaurant / ticket / other，見「口袋名單」下方新增的 bookingModal
        const collapsedCats = reactive({});
        const participants = ref([]);
        const participantsStr = ref('');
        const exchangeRate = ref(0.215);
        // newExpense 的完整形狀（含 category/splitAmongMemberIds/splitMethod/customSplits/notes/匯率快照欄位）
        // 由下面的 createExpenseDraft() 產生；這裡先給一個陽春版初始值，因為 createExpenseDraft 依賴
        // setup（trip baseCurrency）——而 setup 在檔案裡宣告在後面，模組初始化當下還不能呼叫它（TDZ）。
        // currency 留空，交給下面「watch setup.currency」那段在 setup 就緒後自動補上。
        const newExpense = ref({
            title: '', category: 'other', amount: '', currency: '',
            paidByMemberId: '', splitAmongMemberIds: [], splitMethod: 'equal', customSplits: {}, notes: '',
            // exchangeRateToTWD：1 單位 currency 等於多少 TWD，每筆支出建立當下鎖死的快照（見 applyFetchedRate/buildExpenseRateFields）。
            // 這裡刻意留 null 而不是預設 1——currency 一旦不是 TWD 就必須實際抓過／填過匯率才能存檔，
            // 不能讓表單一開始就用一個沒人確認過的 1 通過驗證（需求 H）。
            exchangeRateToTWD: null, exchangeRateFetchedAt: null, exchangeRateSource: 'same-currency', exchangeRateLocked: true,
            summaryCurrency: 'TWD',
            expenseType: 'shared', // UI-only：個人視角表單的「支出類型」快選，不落地存檔（見 setExpenseType 說明）
        });

        // ---- 成員身分登記（memberId）：只給記帳用，跟 checklist/口袋名單既有的「用名字字串當 key」互不影響 ----
        // 每個 participant 名字對應一個穩定、不隨改名/移除而變的 id，寫進 trip 文件的 members 欄位、所有裝置共用。
        // 記帳一律用這個 id（paidByMemberId / splitAmongMemberIds / createdByMemberId…），不是 Firebase 匿名登入的
        // auth.uid——後者是「這台裝置/這次登入」的身分，換裝置或清 storage 就會變，沒辦法拿來跨裝置代表同一個人。
        // 移除 participant 不會刪掉對應的 member 記錄（append-only），這樣舊支出的付款人名字才不會變成查無此人。
        const members = ref([]); // [{ id, name }]
        // ---- 防呆：members 資料本身若混進 null 或沒有 id 的髒項目（理論上不該發生，但同步/合併資料時
        // 曾經看過），後面所有 members.value.map(m => m.id) 之類的地方全部會被拖累（輕則多一個 undefined id，
        // 重則直接整頁 crash）。往後所有結算相關計算一律改讀這個過濾過的版本，不要直接讀 members.value。
        const safeMembers = computed(() => (Array.isArray(members.value) ? members.value.filter(m => m && m.id) : []));
        const memberIdByName = (name) => safeMembers.value.find(m => m.name === name)?.id || null;
        const memberNameById = (id) => safeMembers.value.find(m => m.id === id)?.name || '';
        const ensureMemberRecord = (name) => {
            if (!name) return null;
            let rec = safeMembers.value.find(m => m.name === name);
            if (!rec) { rec = { id: generateId(), name }; members.value.push(rec); }
            return rec.id;
        };
        // 只給「目前使用中」的成員選（付款人下拉選單用），排除已被移除但仍保留歷史紀錄的舊成員
        const activeMembers = computed(() => safeMembers.value.filter(m => participants.value.includes(m.name)));
        // 這台裝置目前的身分沿用 activeChecklistMember（旅遊清單「這是誰」的選擇，全 app 唯一一套裝置身分機制）
        const currentActorMemberId = computed(() => {
            const name = activeChecklistMember.value;
            if (!name || name === '__shared__') return null;
            return memberIdByName(name);
        });
        // participants 一變動就自動補登記對應 member（新加入的名字補一筆；不會因為名字被移除就刪掉）
        watch(participants, (names) => { names.forEach(n => ensureMemberRecord(n)); }, { immediate: true, deep: true });

        // 支出同步狀態（獨立於下面 syncStatus——那個是整份 trip 文件的存檔狀態，這個只反映記帳彈窗本次存檔）
        const expenseSyncStatus = ref('idle'); // idle | saving | synced | error

        const isRateLoading = ref(false);
        const weather = ref({ temp: null, icon: 'ph-sun', code: 0, location: '', daily: [] });
        const isWeatherEditing = ref(false);
        const setup = ref({ destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google', isAsaTemplate: false });
        // 快速新增支出表單的幣別預設跟著目前旅程的 base currency 走；只在使用者還沒自己選過（空字串）時才補，
        // 避免每次 setup.currency 變動（例如旅伴同時在編輯設定，或切換旅程）就把使用者已選好的幣別蓋掉。
        // 幣別是「自動」補上的、使用者沒有手動觸發 select 的 @change，所以這裡也要順便自動補匯率快照——
        // 不然一筆 currency 已經是 USD、但 exchangeRateToTWD 還是 null 的支出會被 validateExpenseDraft 擋下來，
        // 使用者會搞不懂「我明明什麼都填了」為什麼還是不能存。用 nextTick 延後呼叫 applyFetchedRate：
        // 這行 watch 在 setup() 執行到這裡時就會立刻同步觸發一次（immediate:true），但 applyFetchedRate
        // 要到本函式後面才會被賦值，這裡直接呼叫會撞到 TDZ；nextTick 保證等 setup() 整個跑完才執行。
        watch(() => setup.value.currency, (c) => {
            if (!newExpense.value.currency && c) {
                newExpense.value.currency = c;
                nextTick(() => applyFetchedRate(newExpense.value));
            }
        }, { immediate: true });
        // 「幫誰付」多選預設值：目前使用中的所有成員（等同過去硬寫死 members.value.map(m=>m.id) 的行為，
        // 差別是現在使用者之後可以自己調整多選）。只在真的需要重置整份表單時呼叫（見下方 createExpenseDraft），
        // 平常使用者手動勾選/取消不會被這個函式覆蓋回去。
        const defaultSplitIds = () => activeMembers.value.map(m => m.id);
        // 產生一份全新的支出草稿（新增表單重置、切換旅程時都用這個，避免上一趟旅程的欄位殘留）。
        // 只能在 setup/activeMembers 都已就緒之後呼叫（即模組初始化完成後的任何時間點），不能在檔案頂層立刻呼叫。
        const createExpenseDraft = () => ({
            title: '', category: 'other', amount: '',
            currency: setup.value.currency || 'USD',
            // 預設付款人是目前的身份（見打包清單既有的 activeChecklistMember/currentActorMemberId 機制）——
            // 大多數時候「新增支出的人」就是「付錢的人」，不用每次都手動選一次自己。
            paidByMemberId: currentActorMemberId.value || '',
            splitAmongMemberIds: defaultSplitIds(),
            splitMethod: 'equal',
            customSplits: {},
            notes: '',
            // 同上：不預設 1，交給呼叫端在建立完 draft 後呼叫 applyFetchedRate 補上真的匯率（TWD 會立刻同步補 1，
            // 其他幣別才會真的打 API）。
            exchangeRateToTWD: null,
            exchangeRateFetchedAt: null,
            exchangeRateSource: 'same-currency',
            exchangeRateLocked: true,
            summaryCurrency: 'TWD',
            expenseType: 'shared',
        });
        // ---- 支出類型快選（個人 / 共同 / 代付）：需求 F，讓新增支出時明確選「這是什麼性質的支出」-------------
        // 這是表單層的「預設值捷徑」，不是新的資料欄位——實際存進 Firestore 的仍然只有 paidByMemberId/
        // splitAmongMemberIds/splitMethod/customSplits 這四個既有欄位，事後用 expenseKind() 就能從這四個欄位
        // 反推出這筆支出屬於哪一類，不需要另外存一個 type 欄位造成兩份真相。使用者選了「個人支出」之後又手動
        // 把分攤對象改回多人，這筆支出下次讀回來就會被 expenseKind() 正確判斷成「共同支出」——這是刻意的行為，
        // 因為分類永遠應該以實際資料為準，不是以「當初新增時點了哪個按鈕」為準。
        const setExpenseType = (draft, type) => {
            draft.expenseType = type;
            if (type === 'personal') {
                // 個人支出：付款人鎖定為自己，分攤對象固定只有自己，不進共同分帳
                draft.paidByMemberId = currentActorMemberId.value || draft.paidByMemberId || '';
                draft.splitMethod = 'personal';
                draft.splitAmongMemberIds = draft.paidByMemberId ? [draft.paidByMemberId] : [];
                draft.customSplits = {};
            } else if (type === 'reimbursement') {
                // 代付：付款人預設是自己（仍可改選其他人），分攤對象預設清空——逼使用者明確選被代付的人，
                // 而不是沿用「共同支出」殘留的多選狀態（那樣容易把自己也算進分攤對象，變成「共同支出」而非代付）
                if (draft.splitMethod === 'personal') draft.splitMethod = 'equal';
                if (!draft.paidByMemberId) draft.paidByMemberId = currentActorMemberId.value || '';
                draft.splitAmongMemberIds = [];
                draft.customSplits = {};
            } else {
                // 共同支出：付款人/分攤對象都可自由選，預設分攤對象是全體現有成員（平分）
                if (draft.splitMethod === 'personal') draft.splitMethod = 'equal';
                if (!draft.splitAmongMemberIds.length) draft.splitAmongMemberIds = defaultSplitIds();
            }
        };
        // 切換分攤方式：離開 personal 才把分攤對象還原成預設全員（避免使用者手動勾選的組合被平白清空）；
        // 進入 personal 則固定只有付款人一人，這樣「個人支出不進共同分帳」不需要在結算邏輯另外特判
        // （expenseMemberShares 對 personal 的處理本來就是「全額算在付款人自己頭上」，share=paid，淨額自然是 0）。
        const setSplitMethod = (draft, method) => {
            const prevMethod = draft.splitMethod;
            draft.splitMethod = method;
            if (method === 'personal') {
                draft.splitAmongMemberIds = draft.paidByMemberId ? [draft.paidByMemberId] : [];
            } else if (prevMethod === 'personal') {
                draft.splitAmongMemberIds = defaultSplitIds();
            }
            if (method !== 'customAmount' && method !== 'customPercent') draft.customSplits = {};
        };
        // 個人支出模式下，分攤對象永遠等於付款人；付款人一換，分攤對象要跟著換，不然會變成「A 付錢但算在 B 頭上」
        const onExpensePayerChange = (draft) => {
            if (draft.splitMethod === 'personal') draft.splitAmongMemberIds = draft.paidByMemberId ? [draft.paidByMemberId] : [];
        };
        const toggleSplitMember = (draft, memberId) => {
            const idx = draft.splitAmongMemberIds.indexOf(memberId);
            if (idx === -1) {
                draft.splitAmongMemberIds.push(memberId);
                if (draft.customSplits[memberId] == null) draft.customSplits[memberId] = 0;
            } else {
                draft.splitAmongMemberIds.splice(idx, 1);
                delete draft.customSplits[memberId];
            }
        };
        // 自訂金額/比例目前選取成員的合計，用來即時提示使用者「還差多少才會等於總金額／100%」
        const customSplitTotal = (draft) => draft.splitAmongMemberIds.reduce((s, id) => s + (Number(draft.customSplits[id]) || 0), 0);
        const customSplitRemaining = (draft) => {
            const total = customSplitTotal(draft);
            const target = draft.splitMethod === 'customPercent' ? 100 : (Number(draft.amount) || 0);
            return Math.round((target - total) * 100) / 100;
        };
        // ---- 支出表單驗證（需求 F）：回傳明確的錯誤訊息字串，不回傳籠統的「請檢查網路」；null 代表通過 ----
        const validateExpenseDraft = (draft) => {
            if (!draft.title || !draft.title.trim()) return '請輸入支出名稱';
            const amt = Number(draft.amount);
            if (!draft.amount || !(amt > 0)) return '請輸入有效金額';
            if (!draft.paidByMemberId) return '請選擇付款者';
            if (draft.splitMethod !== 'personal' && (!draft.splitAmongMemberIds || !draft.splitAmongMemberIds.length)) return '請至少選擇一位分攤對象';
            // 需求 D4：非 TWD 支出一定要有換算成台幣的匯率，不能悄悄用 1 或任何預設值頂替，
            // 否則總結算會把不同幣別的原始數字直接加在一起（就是這次要修的錯誤 bug 的根源）。
            if ((draft.currency || 'TWD') !== 'TWD' && !(Number(draft.exchangeRateToTWD) > 0)) return '缺少匯率，請補齊';
            if (draft.splitMethod === 'customAmount') {
                const remain = customSplitRemaining(draft);
                if (Math.abs(remain) > 0.01) return `自訂金額總和需等於支出金額（尚差 ${remain}）`;
            }
            if (draft.splitMethod === 'customPercent') {
                const remain = customSplitRemaining(draft);
                if (Math.abs(remain) > 0.01) return `自訂比例總和需為 100%（尚差 ${remain}%）`;
            }
            return null;
        };
        // ---- Firebase 寫入錯誤訊息（需求 F）：把 error.code 直接秀出來，不要籠統的「請檢查網路」 ----
        // permission-denied 特別獨立出一句可以直接照著排查的提示：這種錯誤幾乎都不是使用者能自己解決的網路問題，
        // 而是 Firestore 規則沒放行這個寫入路徑（例如 rules 檔案本機改了但還沒在 Firebase Console 發布），
        // 所以訊息直接點名「請檢查 firestore.rules」，把排查方向指給看得懂的人（開發者/管理員），而不是叫使用者重試。
        const firebaseErrorMessage = (e, fallback = '新增支出失敗') => {
            if (e && e.code === 'permission-denied') return 'Firebase 權限不足，請檢查 firestore.rules';
            if (e && (e.code === 'invalid-argument' || e.code === 'failed-precondition')) return 'Firebase 寫入失敗：欄位格式錯誤';
            if (e && e.code) return `Firebase 寫入失敗：${e.code}`;
            if (e && e.message) return `${fallback}：${e.message}`;
            return `${fallback}，請稍後再試`;
        };
        // ---- 匯率快照欄位（需求 A/B/C）：currency 是 TWD 就固定 1 / same-currency；
        // 不同的話沿用 draft 上已經有的 exchangeRateToTWD/exchangeRateSource（由 applyFetchedRate
        // 自動抓或使用者手動輸入），存檔當下鎖死（exchangeRateLocked:true），之後最新匯率再變也不會回頭改這筆
        // ——每筆支出的匯率快照只在使用者自己開這筆的編輯彈窗、手動按「更新此筆匯率」時才會變。
        const buildExpenseRateFields = (draft) => {
            if ((draft.currency || 'TWD') === 'TWD') {
                return { exchangeRateToTWD: 1, exchangeRateSource: 'same-currency', exchangeRateFetchedAt: null, exchangeRateLocked: true, summaryCurrency: 'TWD' };
            }
            // 不可以在這裡 `|| 1` 頂替缺欄位的匯率（那樣就是這次要修的 bug 本身）：
            // validateExpenseDraft 已經擋在存檔之前要求必須有正數匯率，這裡缺的話讓它保持 null，
            // 讓 expenseNeedsRate/UI 警告清楚標示出來，而不是悄悄污染總額。
            return {
                exchangeRateToTWD: Number(draft.exchangeRateToTWD) > 0 ? Number(draft.exchangeRateToTWD) : null,
                exchangeRateSource: draft.exchangeRateSource === 'api' ? 'api' : 'manual',
                exchangeRateFetchedAt: draft.exchangeRateFetchedAt || null,
                exchangeRateLocked: true,
                summaryCurrency: 'TWD',
            };
        };
        // ---- 自動抓匯率（需求 B）：直接抓「1 單位 currency = 多少 TWD」，不再繞經旅程 base currency 換算——
        // 兩段式換算（currency→base→TWD）會讓「base currency 本身的支出」永遠沒有自己的 TWD 匯率快照，
        // 只能依賴畫面上另一個會變動、沒鎖定的旅程匯率欄位，這正是總結算金額算錯的根本原因。
        // API 失敗要讓使用者知道「匯率取得失敗，請手動輸入匯率」，不是籠統的網路錯誤，也不能整個 catch 吞掉不出聲
        // ——console.error 一定要印，UI 也要有明確提示。免金鑰 API（exchangerate-api.com），前端可直接呼叫。
        const applyFetchedRate = async (draft) => {
            if (!draft.currency || draft.currency === 'TWD') {
                draft.exchangeRateToTWD = 1; draft.exchangeRateSource = 'same-currency'; draft.exchangeRateFetchedAt = null;
                return;
            }
            draft.exchangeRateSource = 'loading';
            try {
                const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${draft.currency}`);
                if (!res.ok) throw new Error(`http-${res.status}`);
                const data = await res.json();
                const rate = data?.rates?.TWD;
                if (!rate) throw new Error('rate-not-found');
                draft.exchangeRateToTWD = rate;
                draft.exchangeRateSource = 'api';
                draft.exchangeRateFetchedAt = new Date().toISOString();
            } catch (e) {
                console.error('Fetch exchange rate failed', e);
                draft.exchangeRateSource = 'manual';
                draft.exchangeRateFetchedAt = null;
                showToast('匯率取得失敗，請手動輸入匯率', { icon: 'ph-bold ph-warning' });
            }
        };

        const currentDay = computed(() => days.value[currentDayIdx.value] || { items: [], flight: null, date: '', title: '' });
        // 一般 timeline 一律不顯示航班：正常情況下 day.items 不會混進 type:'flight' 的項目（航班只會產生/更新
        // day.flight，見 syncFlightBookingToFlightInfo），這裡多一層 filter 純粹是防禦性的，避免未來哪裡不小心
        // 又把航班塞進一般 itinerary item。
        const currentDayTimelineItems = computed(() => (currentDay.value.items || []).filter(i => i && i.type !== 'flight'));
        // editingState.flight 是全站共用的單一旗標（不是逐日各自一份）：換日期卡片時若沒重置，
        // 上一天忘記按「完成」就切走的話，會讓下一天的航班卡片也卡在編輯模式（看不到摘要/轉機時間）。
        watch(currentDayIdx, () => { editingState.dayTitle = false; editingState.flight = false; });

        // ---- 記帳分類 / 分攤方式常數 ----------------------------------------------------------------
        const EXPENSE_CATEGORIES = [
            { slug: 'lodging', label: '住宿', icon: 'ph-bold ph-bed' },
            { slug: 'food', label: '餐飲', icon: 'ph-bold ph-fork-knife' },
            { slug: 'transport', label: '交通', icon: 'ph-bold ph-car' },
            { slug: 'ticket', label: '門票', icon: 'ph-bold ph-ticket' },
            { slug: 'shopping', label: '購物', icon: 'ph-bold ph-shopping-bag' },
            { slug: 'other', label: '其他', icon: 'ph-bold ph-dots-three-circle' },
        ];
        const expenseCategoryLabel = (slug) => EXPENSE_CATEGORIES.find(c => c.slug === slug)?.label || '其他';
        const expenseCategoryIcon = (slug) => EXPENSE_CATEGORIES.find(c => c.slug === slug)?.icon || 'ph-bold ph-dots-three-circle';
        const SPLIT_METHODS = [
            { slug: 'equal', label: '平分' },
            { slug: 'personal', label: '個人支出' },
            { slug: 'customAmount', label: '自訂金額' },
            { slug: 'customPercent', label: '自訂比例' },
        ];
        const splitMethodLabel = (slug) => SPLIT_METHODS.find(m => m.slug === slug)?.label || '平分';
        // 「共同支出」「代付」底下的分攤方式子選單：不重複顯示「個人支出」——那個由上層的「支出類型」
        // 快選負責，兩個地方都能選「個人支出」會讓使用者搞不清楚要點哪一個。
        const SHARED_SPLIT_METHODS = SPLIT_METHODS.filter(m => m.slug !== 'personal');
        const EXPENSE_TYPE_OPTIONS = [
            { slug: 'personal', label: '個人支出', icon: 'ph-bold ph-user' },
            { slug: 'shared', label: '共同支出', icon: 'ph-bold ph-users-three' },
            { slug: 'reimbursement', label: '幫別人代付', icon: 'ph-bold ph-hand-coins' },
        ];

        // ---- 記帳頁防呆：記帳頁不可以因為任何一筆 expense/member 缺欄位就整頁空白 -------------------------
        // moneyViewError 是記帳頁專屬的錯誤旗標（不影響 itinerary/bookings/checklist 等其他頁面），
        // 任何一個結算相關 computed 內部發生非預期錯誤時都會設這個值，UI 端顯示「記帳資料載入失敗」banner，
        // 而不是整頁 crash 變白畫面；真正的錯誤內容一律 console.error 出來方便排查。
        const moneyViewError = ref('');
        const reportMoneyViewError = (where, err) => {
            console.error(`[記帳頁] ${where} 失敗`, err);
            moneyViewError.value = `記帳資料載入失敗，請檢查某筆支出資料（${where}）`;
        };
        // ---- normalizeExpense（需求 D）：把任何一筆 expense 攤平成後面計算/畫面永遠能安全讀取的形狀。
        // 涵蓋三類舊資料落差：(1) 更早期 schema 用 paidBy/splitAmong 存「名字」而不是 paidByMemberId/
        // splitAmongMemberIds 存「memberId」；(2) currency/amount 缺欄位或格式壞掉；(3) 這次修正之前建立、
        // 沒有 exchangeRateToTWD 快照的支出。只在記憶體裡正規化，不會寫回 Firestore——避免「畫面看到的」
        // 跟「資料庫存的」兩邊不一致，使用者要真的補齊資料還是得透過編輯彈窗存檔。
        const normalizeExpense = (raw) => {
            if (!raw || typeof raw !== 'object') return null;
            const warnings = [];
            const e = { ...raw };

            // 1. paidByMemberId 缺失但有舊版 paidBy（名字字串）時，嘗試對應 trip.members
            if (!e.paidByMemberId && e.paidBy) {
                const id = memberIdByName(e.paidBy);
                if (id) e.paidByMemberId = id; else warnings.push('付款人資料找不到對應成員');
            }
            // 2. splitAmongMemberIds 缺失但有舊版 splitAmong（名字陣列）時，嘗試轉成 memberId array
            if ((!e.splitAmongMemberIds || !e.splitAmongMemberIds.length) && Array.isArray(e.splitAmong) && e.splitAmong.length) {
                const ids = e.splitAmong.map(memberIdByName).filter(Boolean);
                if (ids.length) e.splitAmongMemberIds = ids; else warnings.push('分攤對象找不到對應成員');
            }
            if (!Array.isArray(e.splitAmongMemberIds)) e.splitAmongMemberIds = [];

            // 3. currency 缺失時顯示 Unknown，不要 crash（後面 expenseNeedsRate 會因此正確標示缺匯率）
            if (!e.currency) { e.currency = 'Unknown'; warnings.push('缺少幣別'); }

            // 4. amount 轉成 number，無效時標記 warning 並退回 0（不能讓 NaN 一路傳染到加總）
            const amt = Number(e.amount);
            if (!Number.isFinite(amt)) { e.amount = 0; warnings.push('金額格式錯誤'); } else { e.amount = amt; }

            // 5/6. exchangeRateToTWD：TWD 補 1；非 TWD 缺匯率不可以補 1，只能標警告讓 UI 顯示「缺少匯率，請補齊」
            if (!(Number(e.exchangeRateToTWD) > 0)) {
                if (e.currency === 'TWD') { e.exchangeRateToTWD = 1; }
                else { e.exchangeRateToTWD = null; warnings.push('缺少匯率，請補齊'); }
            } else {
                e.exchangeRateToTWD = Number(e.exchangeRateToTWD);
            }

            // 7. summaryAmountTWD 缺失時，若匯率已知就重新算一次（純顯示用，exchangeRateToTWD 才是唯一真相）
            if (!(Number(e.summaryAmountTWD) >= 0) && Number(e.exchangeRateToTWD) > 0) {
                e.summaryAmountTWD = e.amount * e.exchangeRateToTWD;
            }

            if (warnings.length) e.normalizeWarnings = warnings;
            return e;
        };
        // ---- 記帳 / 結算：settlement 一律從「目前未刪除的 expenses」即時算出來，不手動存一份「誰欠誰」的結果 ----
        // 好處：這份結果永遠跟 expenses 一致，不會有「改了支出但結算沒跟著更新」或兩邊對不上的情形。
        // 每筆都先過 normalizeExpense，單筆壞資料只會讓那一筆被跳過（並記一次錯誤），不會讓整個記帳頁死掉。
        const activeExpenses = computed(() => {
            try {
                return expenses.value
                    .map(raw => { try { return normalizeExpense(raw); } catch (err) { console.error('normalizeExpense failed', err, raw); return null; } })
                    .filter(e => e && !e.deleted);
            } catch (err) {
                reportMoneyViewError('activeExpenses', err);
                return [];
            }
        });
        // 依 createdAt 新到舊排序：expenses 現在來自 subcollection 的 onSnapshot，Firestore 不保證回傳順序
        const visibleExpenses = computed(() => {
            try {
                return activeExpenses.value.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
            } catch (err) {
                reportMoneyViewError('visibleExpenses', err);
                return [];
            }
        });
        // 換算成台幣的金額（需求 D）：TWD 支出直接用原始金額；其他幣別必須用「這筆支出自己儲存」的
        // exchangeRateToTWD 快照，之後最新匯率再怎麼變都不會回頭改這筆歷史帳（需求 C 匯率鎖定規則 2）。
        // 缺匯率的舊資料/例外情況一律回傳 0，不能 `|| 1` 頂替——那正是「USD 703 被當成 703 TWD 直接加總」
        // 這個 bug 的根源。缺匯率的支出改由 expenseNeedsRate/expensesMissingRate 標示警告，UI 上明確提示補齊，
        // 而不是讓總額悄悄用錯的數字。
        const expenseAmountTWD = (e) => {
            if (!e) return 0;
            const amt = Number(e.amount) || 0;
            if ((e.currency || 'TWD') === 'TWD') return amt;
            const rate = Number(e.exchangeRateToTWD);
            return rate > 0 ? amt * rate : 0;
        };
        const totalExpense = computed(() => {
            try {
                return activeExpenses.value.reduce((sum, e) => sum + expenseAmountTWD(e), 0);
            } catch (err) {
                reportMoneyViewError('totalExpense', err);
                return 0;
            }
        });
        // 單筆支出「每個成員分攤多少」（原始幣別金額）。splitMethod：
        // - personal：個人支出，全額算在付款人自己頭上（分攤對象固定只有付款人），不進共同分帳——
        //   這樣付款人的 paid - share = 0，不需要另外在結算/轉帳邏輯裡特判「這筆不算」。
        // - customAmount / customPercent：直接照 customSplits 指定的金額／比例分。
        // - equal（含未設定時的預設）：splitAmongMemberIds 平分；若這欄位是空的（理論上不該發生，欄位已在
        //   表單強制至少選一人），退回付款人自己一人，避免這筆支出憑空消失在結算裡。
        const expenseMemberShares = (e) => {
            const amount = Number(e.amount) || 0;
            if (e.splitMethod === 'personal') return e.paidByMemberId ? { [e.paidByMemberId]: amount } : {};
            const ids = (e.splitAmongMemberIds && e.splitAmongMemberIds.length) ? e.splitAmongMemberIds : (e.paidByMemberId ? [e.paidByMemberId] : []);
            if (!ids.length) return {};
            if (e.splitMethod === 'customAmount' && e.customSplits) {
                const out = {}; ids.forEach(id => { out[id] = Number(e.customSplits[id]) || 0; }); return out;
            }
            if (e.splitMethod === 'customPercent' && e.customSplits) {
                const out = {}; ids.forEach(id => { out[id] = amount * (Number(e.customSplits[id]) || 0) / 100; }); return out;
            }
            const share = amount / ids.length;
            const out = {}; ids.forEach(id => { out[id] = share; }); return out;
        };
        // ---- 支出分類：個人 personal / 代付 reimbursement / 共同 shared ------------------------------
        // 純粹從 paidByMemberId + splitAmongMemberIds + splitMethod 三個既有欄位判斷出來，不另外存一個
        // type 欄位——存了反而會有「type 跟實際 split 欄位兜不起來」的兩份真相風險（例如編輯時只改了
        // splitAmongMemberIds 卻忘記同步改 type）。分類規則跟使用者需求文件一致：
        //   personal：splitMethod === 'personal'，或分攤對象只有付款人自己一個
        //   reimbursement：付款人不在分攤對象名單裡（可能代付一人或多人，但自己不用出錢）
        //   shared：其餘情況（分攤對象含 2 人以上，且付款人也在其中）
        const expenseKind = (e) => {
            if (!e) return 'shared';
            if (e.splitMethod === 'personal') return 'personal';
            const among = (e.splitAmongMemberIds && e.splitAmongMemberIds.length) ? e.splitAmongMemberIds : (e.paidByMemberId ? [e.paidByMemberId] : []);
            if (among.length <= 1 && among[0] === e.paidByMemberId) return 'personal';
            if (e.paidByMemberId && !among.includes(e.paidByMemberId)) return 'reimbursement';
            return 'shared';
        };
        const expenseKindLabel = (k) => ({ personal: '個人支出', reimbursement: '代付', shared: '共同支出' }[k] || '共同支出');
        // 這筆支出「預設」該不該讓 memberId 這個人在列表裡看到：
        // - shared：所有人都看得到——共同分攤的錢需要彼此核對，避免誤植，故意不做隱藏。
        // - personal：只有本人。
        // - reimbursement：只有付款人跟被代付的人（其他不相干的旅伴不需要看到這筆「W 幫 J 買票」的細節）。
        // 這只影響「列表要不要顯示這張卡片」，不影響 settlement 計算——settlement 一律用全部資料算，
        // 每個人只是看到跟自己有關的那一部分結果，不代表其他人的錢就沒被正確算進去。
        const expenseVisibleToMember = (e, memberId) => {
            const kind = expenseKind(e);
            if (kind === 'shared') return true;
            if (kind === 'personal') return e.paidByMemberId === memberId;
            return e.paidByMemberId === memberId || (e.splitAmongMemberIds || []).includes(memberId);
        };
        // 誰欠誰：貪心債務簡化（欠最多的付給收最多的，逐步清零），把 net balance 換算成建議轉帳筆數最少的方案
        const computeGreedyTransfers = (netMap, idToName) => {
            const balances = Object.entries(netMap)
                .map(([id, balance]) => ({ id, name: idToName(id) || id, balance }))
                .filter(b => Math.abs(b.balance) > 0.01);
            const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance).map(b => ({ ...b }));
            const debtors = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance).map(b => ({ ...b }));
            const transfers = [];
            let ci = 0, di = 0;
            while (ci < creditors.length && di < debtors.length) {
                const c = creditors[ci], d = debtors[di];
                const amt = Math.min(c.balance, -d.balance);
                if (amt > 0.01) transfers.push({ fromId: d.id, from: d.name, toId: c.id, to: c.name, amount: Math.round(amt * 100) / 100 });
                c.balance -= amt; d.balance += amt;
                if (Math.abs(c.balance) < 0.01) ci++;
                if (Math.abs(d.balance) < 0.01) di++;
            }
            return transfers;
        };
        // 每一種原始幣別各自獨立結算（需求 C）：同一筆支出只會落在自己的 currency 分組裡，
        // 不會跨幣別互抵——USD 的債務只能用 USD 轉帳結清，TWD 另外結。base currency 一定會出現在清單第一位，
        // 即使目前沒有任何 base currency 的支出，也讓「已結清」狀態有地方顯示。
        const expenseCurrency = (e) => e.currency || setup.value.currency || 'USD';
        const usedCurrencies = computed(() => {
            const base = setup.value.currency || 'USD';
            const others = Array.from(new Set(activeExpenses.value.map(expenseCurrency))).filter(c => c !== base).sort();
            return [base, ...others];
        });
        // paid/share/net/誰欠誰只能算「共同支出＋代付」（nonPersonalExpenses），個人支出不能混進來：
        // personal 的 paid 剛好等於 share（見 expenseMemberShares），淨額算出來雖然還是 0、不影響其他人，
        // 但這兩個表格是「全體結算」畫面，所有旅伴都看得到——如果把個人支出金額也灌進 paid/share，
        // 等於間接讓別人看到「這個人今天個人花了多少錢」，違反個人支出只有本人看得到的隱私規則。
        // total（原始幣別小計／旅程總支出）則刻意仍然算全部（含個人）——那是「這趟旅程總共花了多少錢」的
        // 誠實總額，跟「誰欠誰」是兩件事，不需要為了隱私而縮水。
        const nonPersonalExpenses = computed(() => activeExpenses.value.filter(e => expenseKind(e) !== 'personal'));
        const settlementByCurrency = computed(() => {
            try {
                const memberIds = safeMembers.value.map(m => m.id);
                return usedCurrencies.value.map(cur => {
                    const paid = {}; const share = {};
                    memberIds.forEach(id => { paid[id] = 0; share[id] = 0; });
                    const inCurrencyAll = activeExpenses.value.filter(e => expenseCurrency(e) === cur);
                    const inCurrencyShared = nonPersonalExpenses.value.filter(e => expenseCurrency(e) === cur);
                    inCurrencyShared.forEach(e => {
                        if (e.paidByMemberId) paid[e.paidByMemberId] = (paid[e.paidByMemberId] || 0) + (Number(e.amount) || 0);
                        Object.entries(expenseMemberShares(e)).forEach(([id, v]) => { share[id] = (share[id] || 0) + v; });
                    });
                    const net = {}; memberIds.forEach(id => { net[id] = (paid[id] || 0) - (share[id] || 0); });
                    return {
                        currency: cur,
                        total: inCurrencyAll.reduce((s, e) => s + (Number(e.amount) || 0), 0),
                        paid, share, net,
                        transfers: computeGreedyTransfers(net, memberNameById),
                    };
                });
            } catch (err) {
                reportMoneyViewError('settlementByCurrency', err);
                return [];
            }
        });
        // ---- 總結算主要顯示幣別固定為台幣（需求 E/F/J）：不再區分「trip base currency」跟「summary currency」
        // 兩套換算——每筆 expense 都直接鎖了自己的 exchangeRateToTWD，總結算/每人淨額一律用這一份台幣快照加總，
        // 不會有「base currency 支出沒有自己的匯率快照，得現抓一個沒鎖定的旅程共用匯率」這種落差（就是原本的 bug）。
        // 個人支出不計入 paid/share/net（見 nonPersonalExpenses 的說明），total 則刻意仍計入全部（含個人）。
        // 找不到 computed 的 net/paid/share 時使用的安全預設值（需求 B）：任何呼叫端與其直接讀
        // undefined.net，都應該先用 `xxx || createEmptyMemberSummary()` 頂一份這個形狀。
        const createEmptyMemberSummary = () => ({
            paidByCurrency: {}, shareByCurrency: {}, netByCurrency: {},
            paidSummaryTWD: 0, shareSummaryTWD: 0, netSummaryTWD: 0,
            net: 0, warnings: [],
        });
        const twdSummary = computed(() => {
            try {
                const memberIds = safeMembers.value.map(m => m.id);
                const paid = {}; const share = {};
                memberIds.forEach(id => { paid[id] = 0; share[id] = 0; });
                nonPersonalExpenses.value.forEach(e => {
                    if (expenseNeedsRate(e)) return; // 缺匯率的支出不能悄悄用錯的數字污染總覽，改由 expensesMissingRate 警告
                    const rate = (e.currency || 'TWD') === 'TWD' ? 1 : Number(e.exchangeRateToTWD);
                    if (e.paidByMemberId) paid[e.paidByMemberId] = (paid[e.paidByMemberId] || 0) + (Number(e.amount) || 0) * rate;
                    Object.entries(expenseMemberShares(e)).forEach(([id, v]) => { share[id] = (share[id] || 0) + v * rate; });
                });
                const net = {}; memberIds.forEach(id => { net[id] = (paid[id] || 0) - (share[id] || 0); });
                return { total: totalExpense.value, paid, share, net };
            } catch (err) {
                reportMoneyViewError('twdSummary', err);
                return { total: 0, paid: {}, share: {}, net: {} };
            }
        });
        // ---- 「全體結算」內「每位成員總覽」只能用純共同支出（shared，不含 reimbursement）：
        // reimbursement 依規則只有付款人與受益人看得到，但「每位成員總覽」是所有旅伴都看得到的畫面，
        // 如果 paid/share/淨額混進 reimbursement，等於把「誰幫誰代付了多少」這種只該讓當事人知道的錢
        // 攤在所有人面前，違反代付隱私規則。「誰欠誰」轉帳建議刻意仍用 settlementByCurrency（含 reimbursement），
        // 才能正確算出真實欠款——這裡只是另外算一份「乾淨」的顯示用數字，不影響原本的結算公式。
        const sharedOnlyExpenses = computed(() => activeExpenses.value.filter(e => expenseKind(e) === 'shared'));
        const sharedOnlySettlementByCurrency = computed(() => {
            try {
                const memberIds = safeMembers.value.map(m => m.id);
                return usedCurrencies.value.map(cur => {
                    const paid = {}; const share = {};
                    memberIds.forEach(id => { paid[id] = 0; share[id] = 0; });
                    sharedOnlyExpenses.value.filter(e => expenseCurrency(e) === cur).forEach(e => {
                        if (e.paidByMemberId) paid[e.paidByMemberId] = (paid[e.paidByMemberId] || 0) + (Number(e.amount) || 0);
                        Object.entries(expenseMemberShares(e)).forEach(([id, v]) => { share[id] = (share[id] || 0) + v; });
                    });
                    const net = {}; memberIds.forEach(id => { net[id] = (paid[id] || 0) - (share[id] || 0); });
                    return { currency: cur, paid, share, net };
                });
            } catch (err) {
                reportMoneyViewError('sharedOnlySettlementByCurrency', err);
                return [];
            }
        });
        const sharedOnlyNetTWD = computed(() => {
            try {
                const memberIds = safeMembers.value.map(m => m.id);
                const net = {}; memberIds.forEach(id => { net[id] = 0; });
                sharedOnlyExpenses.value.forEach(e => {
                    if (expenseNeedsRate(e)) return;
                    const rate = (e.currency || 'TWD') === 'TWD' ? 1 : Number(e.exchangeRateToTWD);
                    if (e.paidByMemberId) net[e.paidByMemberId] = (net[e.paidByMemberId] || 0) + (Number(e.amount) || 0) * rate;
                    Object.entries(expenseMemberShares(e)).forEach(([id, v]) => { net[id] = (net[id] || 0) - v * rate; });
                });
                return net;
            } catch (err) {
                reportMoneyViewError('sharedOnlyNetTWD', err);
                return {};
            }
        });
        // ---- 「約合 {{ trip base currency }}」次要參考（需求 E 第 3 點，選配）：只用來給習慣看 USD 的人一個
        // 大概的數字，不是任何計算的依據。刻意不用畫面上可編輯、沒鎖定的旅程匯率欄位反推（那正是原本 bug 的源頭），
        // 而是取「最近一筆 base currency 支出」自己鎖定的 exchangeRateToTWD 當作目前的參考匯率——
        // 這樣就一定是某筆支出當下真實抓到/輸入過的匯率，不會出現「1 USD ≈ NT$1」這種沒人真的輸入過的預設值。
        // 找不到任何一筆已有匯率快照的 base currency 支出時，回傳 null，UI 端直接不顯示這個參考區塊。
        const secondaryReferenceRate = computed(() => {
            try {
                const base = setup.value.currency || 'USD';
                if (base === 'TWD') return null;
                const candidates = activeExpenses.value
                    .filter(e => (e.currency || base) === base && Number(e.exchangeRateToTWD) > 0)
                    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                return candidates.length ? Number(candidates[0].exchangeRateToTWD) : null;
            } catch (err) {
                reportMoneyViewError('secondaryReferenceRate', err);
                return null;
            }
        });
        const secondaryReferenceTotal = computed(() => {
            try {
                const rate = secondaryReferenceRate.value;
                return rate > 0 ? totalExpense.value / rate : null;
            } catch (err) {
                reportMoneyViewError('secondaryReferenceTotal', err);
                return null;
            }
        });
        // ---- 全部改用台幣支付（合併結算）：把「全體結算」裡本來分幣別各自顯示的 USD 結算／TWD 結算
        // 兩筆帳，另外再合併算成一筆台幣總結算，方便使用者實際只需要轉帳一次——不影響、也不取代上面
        // 分幣別各自結算的 settlementByCurrency／transfers，純粹是多一個「懶人版」欄位。
        // 匯率預設沿用「約合 {{ base }}」用的同一個 secondaryReferenceRate（某筆 base currency 支出當下
        // 鎖定的匯率），但額外開放手動輸入覆寫——這裡刻意是「這一個合併結算專用」的匯率，跟每筆 expense
        // 自己鎖定的 exchangeRateToTWD 是兩回事，改這裡不會回頭動到任何一筆支出的記帳資料或約合台幣總額。
        const combinedRateInput = ref('');
        const combinedSettlementRate = computed(() => {
            const manual = Number(combinedRateInput.value);
            if (manual > 0) return manual;
            return secondaryReferenceRate.value || (setup.value.currency === 'TWD' ? 1 : null);
        });
        const combinedSettlementHasForeignCurrency = computed(() => (settlementByCurrency.value || []).some(g => g.currency !== 'TWD'));
        const combinedSettlementMissingRate = computed(() => combinedSettlementHasForeignCurrency.value && !(combinedSettlementRate.value > 0));
        const combinedSettlementNetTWD = computed(() => {
            try {
                const rate = combinedSettlementRate.value;
                const memberIds = safeMembers.value.map(m => m.id);
                const net = {}; memberIds.forEach(id => { net[id] = 0; });
                (settlementByCurrency.value || []).forEach(g => {
                    const r = g.currency === 'TWD' ? 1 : rate;
                    if (!(r > 0)) return; // 缺匯率的幣別跳過，不能悄悄當 1 算
                    memberIds.forEach(id => { net[id] = (net[id] || 0) + (g.net[id] || 0) * r; });
                });
                return net;
            } catch (err) {
                reportMoneyViewError('combinedSettlementNetTWD', err);
                return {};
            }
        });
        const combinedSettlementTransfers = computed(() => {
            try {
                return computeGreedyTransfers(combinedSettlementNetTWD.value, memberNameById);
            } catch (err) {
                reportMoneyViewError('combinedSettlementTransfers', err);
                return [];
            }
        });
        const combinedRatePlaceholder = computed(() => secondaryReferenceRate.value > 0 ? String(Math.round(secondaryReferenceRate.value * 1000) / 1000) : '請輸入匯率');
        // 某人「個人開銷」小計，依原始幣別分開（需求 B「個人開銷：USD 160」），跟上面的 paid/share 完全分開算，
        // 只有本人自己看得到（見下方 myPersonalExpensesList 的可見性判斷）。
        const memberPersonalTotalsByCurrency = (memberId) => {
            const totals = {};
            activeExpenses.value
                .filter(e => expenseKind(e) === 'personal' && e.paidByMemberId === memberId)
                .forEach(e => { const cur = e.currency || setup.value.currency || 'USD'; totals[cur] = (totals[cur] || 0) + (Number(e.amount) || 0); });
            return totals;
        };

        // ---- 個人視角 + 共同帳本：記帳頁從「大家都看全部支出」改成「以目前使用者為中心」--------------------
        // 「我是誰」刻意沿用打包清單既有的裝置身份機制（activeChecklistMember/chooseChecklistMember/
        // checklistMembers，見下方打包清單區塊），不另外做第二套 localStorage 識別、也不另外存一個
        // currentMemberIdForTrip_{tripId}——同一趟旅程只需要選一次「我是誰」，清單和記帳共用同一份身份，
        // 使用者不用選兩次、兩邊也不會不同步。currentActorMemberId 本來就是從 activeChecklistMember 換算出
        // 對應的 memberId，這裡只是取一個在記帳情境下更好懂的名字。
        const currentMemberId = currentActorMemberId;
        // 共同帳本：所有 shared 支出，所有旅伴都看得到（需求 A3／D2：大家要能核對是否誤植）
        const sharedExpensesList = computed(() => visibleExpenses.value.filter(e => expenseKind(e) === 'shared'));
        // 「旅程總支出」主卡片展開/收合細項的開關
        const showTripTotalDetail = ref(false);
        // 我的個人支出：只顯示 currentMemberId 自己的 personal 支出，不顯示其他旅伴的（需求 B3／D1）
        const myPersonalExpensesList = computed(() => {
            const me = currentMemberId.value;
            if (!me) return [];
            return visibleExpenses.value.filter(e => expenseKind(e) === 'personal' && e.paidByMemberId === me);
        });
        // 與我有關的代付/被代付：只顯示付款人或被代付人是我自己的那些（需求 B4／D3）
        const myReimbursementExpensesList = computed(() => {
            const me = currentMemberId.value;
            if (!me) return [];
            return visibleExpenses.value.filter(e => expenseKind(e) === 'reimbursement' && expenseVisibleToMember(e, me));
        });
        // 「我的總覽」：把 settlementByCurrency（已排除個人支出）依目前身份抽出我自己那一列 + 跟我有關的轉帳建議，
        // 再補上我自己的個人開銷小計。currency 清單取「settlementByCurrency 用到的幣別」和「我個人支出用到的
        // 幣別」的聯集——避免我只有一筆 JPY 個人支出、但沒有任何人共同分攤 JPY 時，這個幣別憑空消失不顯示。
        const mySettlementByCurrency = computed(() => {
            try {
                const me = currentMemberId.value;
                if (!me) return [];
                const personalTotals = memberPersonalTotalsByCurrency(me) || {};
                const base = setup.value.currency || 'USD';
                const currencies = new Set((settlementByCurrency.value || []).map(g => g.currency));
                Object.keys(personalTotals).forEach(c => currencies.add(c));
                const ordered = [base, ...Array.from(currencies).filter(c => c !== base).sort()];
                return ordered.map(cur => {
                    const g = (settlementByCurrency.value || []).find(x => x.currency === cur);
                    return {
                        currency: cur,
                        paid: g ? (g.paid?.[me] || 0) : 0,
                        share: g ? (g.share?.[me] || 0) : 0,
                        net: g ? (g.net?.[me] || 0) : 0,
                        personal: personalTotals[cur] || 0,
                        transfers: g && Array.isArray(g.transfers) ? g.transfers.filter(t => t.fromId === me || t.toId === me) : [],
                    };
                }).filter(g => g.paid || g.share || g.personal || g.transfers.length);
            } catch (err) {
                reportMoneyViewError('mySettlementByCurrency', err);
                return [];
            }
        });
        // 成員新增/刪除（直接同步 participantsStr 供存檔；participants 為顯示來源）
        const newParticipant = ref('');
        const addParticipant = () => {
            const name = newParticipant.value.trim();
            if (!name || participants.value.includes(name)) { newParticipant.value = ''; return; }
            participants.value.push(name);
            participantsStr.value = participants.value.join(', ');
            const id = ensureMemberRecord(name); // 立刻登記，不等 watch(participants) 非同步觸發，避免下面拿不到 id
            if (!newExpense.value.paidByMemberId) newExpense.value.paidByMemberId = id;
            // 新加入的人預設也算進「幫誰付」的分攤對象，個人支出模式下分攤對象固定只有付款人，不受影響
            if (newExpense.value.splitMethod !== 'personal' && !newExpense.value.splitAmongMemberIds.includes(id)) {
                newExpense.value.splitAmongMemberIds.push(id);
            }
            newParticipant.value = '';
        };
        const removeParticipant = (name) => {
            const removedId = memberIdByName(name);
            participants.value = participants.value.filter(p => p !== name);
            participantsStr.value = participants.value.join(', ');
            // 不刪 member 記錄本身（舊支出還指著這個 id），只在「目前選的付款人剛好是被移除的這個人」時換掉
            if (newExpense.value.paidByMemberId === removedId) newExpense.value.paidByMemberId = memberIdByName(participants.value[0]) || '';
            newExpense.value.splitAmongMemberIds = newExpense.value.splitAmongMemberIds.filter(id => id !== removedId);
            if (newExpense.value.customSplits && removedId) delete newExpense.value.customSplits[removedId];
        };
        // 多幣別記帳（需求 D）：CURRENCY_SYMBOLS 同時當「幣別代碼下拉選單」的選項來源與符號對照表，
        // trip baseCurrency（setup.currency）若剛好不在這張表裡（例如 AUD），currencyCodeOptions 會自動補上，
        // 確保下拉選單一定選得到目前的 base currency，不會因為不在清單裡而顯示空白。
        const CURRENCY_SYMBOLS = { 'JPY': '¥', 'CNY': '¥', 'USD': '$', 'EUR': '€', 'KRW': '₩', 'GBP': '£', 'TWD': 'NT$', 'HKD': 'HK$', 'THB': '฿', 'VND': '₫' };
        const symbolForCurrency = (code) => CURRENCY_SYMBOLS[code] || (code ? code + ' ' : '$');
        const currencyCodeOptions = computed(() => {
            const codes = Object.keys(CURRENCY_SYMBOLS);
            return setup.value.currency && !codes.includes(setup.value.currency) ? [...codes, setup.value.currency] : codes;
        });
        // 「議程」分頁是 ASA 研討會專屬功能，一般（空白行程）不需要看到。新建立的旅程靠 setup.isAsaTemplate
        // 判斷；這面旗標是這次才加的，在此之前就已經套用過 ASA 範本的舊旅程資料裡不會有這個欄位，讀回來是
        // undefined，所以額外用 destination 字串（範本固定寫死的 'San Diego, ASA 2026'）當退回判斷，
        // 避免舊資料的使用者突然看不到自己原本就在用的議程分頁。
        const isAsaConferenceTrip = computed(() => !!(setup.value.isAsaTemplate || setup.value.destination === ASA_SD_2026_TRIP_DEFAULTS.destination));
        const currencyLabel = computed(() => setup.value.currency || '外幣');
        const currencySymbol = computed(() => symbolForCurrency(setup.value.currency));
        // 結算/總覽金額一律用這個格式化，不能整數 Math.round——分帳常常會出現 .5（例如兩人分攤奇數總額），
        // 直接四捨五入到整數會把「W net: +147.5」顯示成「+148」，數字對不上使用者自己心算的結果（需求：
        // Member Summary / Final Settlement 必須保留到小數點後兩位）。用 toLocaleString 的 maximumFractionDigits
        // 讓整數金額仍顯示 "375" 不會多出 ".00"，只有真的有小數時才顯示到兩位。
        const fmtMoney = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
        // 需求 D4/H：非 TWD 但缺 exchangeRateToTWD 的支出（通常是這次修正之前建立的舊資料）——不能讓 settlement
        // 崩潰，也不能悄悄假裝匯率是 1（那樣算出來的台幣總額會是錯的又不會有任何提示，就是原本的 bug）。
        // expenseAmountTWD 那層計算安全地退回 0（不會把原始數字直接灌進總額），這裡另外標記出來，UI 顯示明確警告
        // 並提供「補齊匯率」入口（開編輯彈窗）。
        const expenseNeedsRate = (e) => !!(e && e.currency && e.currency !== 'TWD' && !(Number(e.exchangeRateToTWD) > 0));
        const expensesMissingRate = computed(() => {
            try {
                return activeExpenses.value.filter(expenseNeedsRate);
            } catch (err) {
                reportMoneyViewError('expensesMissingRate', err);
                return [];
            }
        });
        // ---- 我的旅程總支出（記帳頁主卡片改版）：Total Expense 不再是「全員支出總和」，
        // 而是「目前這個人自己的旅程花費」= 個人支出 + 共同支出的自己分攤額 + 與自己有關代付中「自己受益」的部分。
        // 關鍵是 expenseMemberShares(e)[memberId]：這個既有函式本來就已經依 splitMethod 算出「這筆支出這個人該出多少」——
        // personal 全額算給付款人自己、shared 依比例分、reimbursement 只有受益人有份、付款人是 0——
        // 所以 personal/shared/reimbursement 三種情況天生統一在同一條公式裡，不必分開寫三段加總邏輯，
        // 也不會有「歸類跟加總各算一次、兩邊兜不起來」的風險。myTripTotalTWD 沿用既有的匯率鎖定規則
        // （expenseNeedsRate 判斷缺匯率就跳過、不偷用 1 頂替），不建立第二套換算公式。
        const calculateMemberTripCost = (expenseList, memberId) => {
            const empty = () => ({
                personalExpensesTotalByCurrency: {},
                sharedShareTotalByCurrency: {},
                reimbursementRelatedTotalByCurrency: {},
                myTripTotalByCurrency: {},
                myTripTotalTWD: 0,
                visibleExpensesForCurrentMember: [],
            });
            if (!memberId) return empty();
            const result = empty();
            (expenseList || []).forEach(e => {
                if (!expenseVisibleToMember(e, memberId)) return;
                result.visibleExpensesForCurrentMember.push(e);
                const myShare = expenseMemberShares(e)[memberId] || 0;
                if (!myShare) return;
                const kind = expenseKind(e);
                const cur = e.currency || setup.value.currency || 'USD';
                const bucket = kind === 'personal' ? result.personalExpensesTotalByCurrency
                    : kind === 'shared' ? result.sharedShareTotalByCurrency
                    : result.reimbursementRelatedTotalByCurrency;
                bucket[cur] = (bucket[cur] || 0) + myShare;
                result.myTripTotalByCurrency[cur] = (result.myTripTotalByCurrency[cur] || 0) + myShare;
                if (!expenseNeedsRate(e)) {
                    const rate = (e.currency || 'TWD') === 'TWD' ? 1 : Number(e.exchangeRateToTWD);
                    result.myTripTotalTWD += myShare * rate;
                }
            });
            return result;
        };
        const emptyMemberTripCost = () => ({
            personalExpensesTotalByCurrency: {}, sharedShareTotalByCurrency: {}, reimbursementRelatedTotalByCurrency: {},
            myTripTotalByCurrency: {}, myTripTotalTWD: 0, visibleExpensesForCurrentMember: [],
        });
        const myTripCost = computed(() => {
            try {
                return calculateMemberTripCost(activeExpenses.value, currentMemberId.value);
            } catch (err) {
                reportMoneyViewError('myTripCost', err);
                return emptyMemberTripCost();
            }
        });
        // 主卡片的「原始幣別明細」清單：base currency 一定排第一位，跟 usedCurrencies 的排序邏輯一致，
        // 只是幣別來源換成「我自己的」myTripTotalByCurrency，而不是全員總額。
        const myTripTotalByCurrencyList = computed(() => {
            try {
                const base = setup.value.currency || 'USD';
                const totals = myTripCost.value.myTripTotalByCurrency || {};
                const currencies = new Set(Object.keys(totals));
                currencies.add(base);
                const ordered = [base, ...Array.from(currencies).filter(c => c !== base).sort()];
                return ordered.filter(c => totals[c]).map(c => ({ currency: c, total: totals[c] || 0 }));
            } catch (err) {
                reportMoneyViewError('myTripTotalByCurrencyList', err);
                return [];
            }
        });
        // 主卡片的「約合 base currency」次要參考：跟 secondaryReferenceRate 用同一份鎖定匯率，只是套用在
        // 「我自己的」台幣總額上，不是全員總額——維持同一套匯率規則，不另外造第二套換算公式。
        const mySecondaryReferenceTotal = computed(() => {
            try {
                const rate = secondaryReferenceRate.value;
                return rate > 0 ? myTripCost.value.myTripTotalTWD / rate : null;
            } catch (err) {
                reportMoneyViewError('mySecondaryReferenceTotal', err);
                return null;
            }
        });
        const mapProviderLabel = computed(() => { const map = { 'google': 'Google Maps', 'naver': 'Naver Map', 'amap': '高德地圖' }; return map[setup.value.mapProvider] || '地圖'; });

        const weatherDisplay = computed(() => {
            if (!weather.value) return { temp: '--', icon: 'ph-sun', label: '載入中...', isForecast: false };
            const loc = weather.value.location || (setup.value ? setup.value.destination : '') || '當地';
            if (!currentDay.value || !currentDay.value.fullDate || !weather.value.daily || weather.value.daily.length === 0) {
                return { temp: weather.value.temp !== null ? `${weather.value.temp}°` : '--', icon: weather.value.icon || 'ph-sun', label: loc, isForecast: false };
            }
            const targetDate = currentDay.value.fullDate;
            if (weather.value.daily.time) {
                const idx = weather.value.daily.time.indexOf(targetDate);
                if (idx !== -1) {
                    const max = Math.round(weather.value.daily.temperature_2m_max[idx]);
                    const min = Math.round(weather.value.daily.temperature_2m_min[idx]);
                    return { temp: `${min}°-${max}°`, icon: getWeatherIcon(weather.value.daily.weathercode[idx]), label: loc, isForecast: true };
                }
            }
            return { temp: weather.value.temp !== null ? `${weather.value.temp}°` : '--', icon: weather.value.icon || 'ph-sun', label: loc, isForecast: false };
        });

        const generateId = () => 'item_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const localDateStr = (dt = new Date()) => { const m = dt.getMonth() + 1, d = dt.getDate(); return `${dt.getFullYear()}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`; };
        const fmtExpDate = (s) => { if (!s) return ''; const p = String(s).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}` : s; };
        const getWeatherIcon = (c) => { if (c === 0) return 'ph-sun'; if (c < 4) return 'ph-cloud-sun'; if (c < 50) return 'ph-cloud-fog'; if (c < 70) return 'ph-cloud-rain'; return 'ph-cloud'; };
        const getTimePeriod = (t) => { if (!t) return '時間'; const h = parseInt(t.split(':')[0]); return h < 5 ? '凌晨' : h < 11 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上'; };

        // ---- App 內回饋系統（取代原生 alert/confirm/prompt）----
        // appConfirm：底部確認 sheet，回傳 Promise<boolean>；opts.link 顯示可複製連結
        const dialog = reactive({ show: false, title: '', message: '', confirmText: '確定', cancelText: '取消', danger: false, showCancel: true, link: '' });
        let dialogResolve = null;
        const appConfirm = (message, opts = {}) => new Promise((resolve) => {
            dialog.title = opts.title || '';
            dialog.message = message;
            dialog.confirmText = opts.confirmText || '確定';
            dialog.cancelText = opts.cancelText || '取消';
            dialog.danger = !!opts.danger;
            dialog.showCancel = opts.showCancel !== false;
            dialog.link = opts.link || '';
            dialogResolve = resolve;
            dialog.show = true;
        });
        const dialogAnswer = (ok) => {
            dialog.show = false;
            if (dialogResolve) { dialogResolve(ok); dialogResolve = null; }
        };

        // showToast：底部提示；opts.undo 提供復原函式時顯示「復原」鈕（刪除類操作用，取代確認框）
        const toast = reactive({ show: false, message: '', icon: '', hasUndo: false });
        let toastUndoFn = null;
        let toastTimer = null;
        const showToast = (message, opts = {}) => {
            if (toastTimer) clearTimeout(toastTimer);
            toast.message = message;
            toast.icon = opts.icon || 'ph-bold ph-check-circle';
            toastUndoFn = opts.undo || null;
            toast.hasUndo = !!toastUndoFn;
            toast.show = true;
            toastTimer = setTimeout(() => { toast.show = false; toastUndoFn = null; }, opts.duration || (toastUndoFn ? 5000 : 2200));
        };
        const undoToast = () => {
            if (toastUndoFn) toastUndoFn();
            toastUndoFn = null;
            toast.show = false;
            if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        };

        // ---- 航班：一段航程（去程/回程）可以有多個航班段（轉機）；掛在建立時所在那一天的 day.flight ----
        // 任何旅程的任何一天都可以用，不是 ASA 專屬；ASA 範本只是預先帶入一份資料（見 asa-trip-template.js）
        const createFlightSegment = () => ({
            id: generateId(), airline: '', flightNumber: '', departureAirport: '', arrivalAirport: '',
            departureDateTime: '', arrivalDateTime: '', departureTerminal: '', arrivalTerminal: '',
            confirmationNumber: '', notes: ''
        });
        const toggleFlightCard = () => { if (!currentDay.value.flight) { currentDay.value.flight = { id: generateId(), label: '', segments: [createFlightSegment()] }; editingState.flight = true; } };
        const removeFlight = () => {
            const day = days.value[currentDayIdx.value];
            if (!day || !day.flight) return;
            const removed = day.flight;
            day.flight = null;
            editingState.flight = false;
            showToast('已移除航班資訊', { icon: 'ph-bold ph-trash', undo: () => { day.flight = removed; } });
        };
        const addFlightSegment = (journey, makeSegment = createFlightSegment) => { if (journey) journey.segments.push(makeSegment()); };
        const removeFlightSegment = (journey, segId) => {
            if (!journey) return;
            const idx = journey.segments.findIndex(s => s.id === segId);
            if (idx === -1) return;
            const removed = journey.segments.splice(idx, 1)[0];
            showToast('已刪除航班段', { icon: 'ph-bold ph-trash', undo: () => { journey.segments.splice(Math.min(idx, journey.segments.length), 0, removed); } });
        };
        const moveFlightSegment = (journey, segId, dir) => {
            if (!journey) return;
            const arr = journey.segments;
            const idx = arr.findIndex(s => s.id === segId);
            const target = idx + dir;
            if (idx === -1 || target < 0 || target >= arr.length) return;
            [arr[idx], arr[target]] = [arr[target], arr[idx]];
        };
        // datetime-local 值固定是 "YYYY-MM-DDTHH:mm"，直接切片取時間/日期即可，不需要額外解析
        const formatFlightTime = (dt) => dt ? dt.slice(11, 16) : '--:--';
        const isNextDayArrival = (dep, arr) => !!(dep && arr && dep.slice(0, 10) !== arr.slice(0, 10));
        // 簡單轉機時間計算：兩個 datetime-local 字串直接相減。刻意不做時區轉換——MVP 直接用使用者輸入的
        // 機場當地時間相減（見需求 A 第 6 點），跨日期線的航班（例如去程 BR8 TPE→SFO 當地時間反而變早）
        // 只要兩段時間都是同一套「使用者輸入的當地時間」就還是能算對，不需要額外處理。
        const formatLayover = (arrPrev, depNext) => {
            if (!arrPrev || !depNext) return '';
            const a = new Date(arrPrev), b = new Date(depNext);
            if (isNaN(a) || isNaN(b)) return '';
            const diffMin = Math.round((b - a) / 60000);
            if (diffMin <= 0) return '';
            const h = Math.floor(diffMin / 60), m = diffMin % 60;
            return `轉機 ${h > 0 ? h + ' 小時 ' : ''}${String(m).padStart(2, '0')} 分鐘`;
        };
        // 只要存在下一段（idx < length-1），一律顯示點什麼：算得出來就顯示時間，資料不足（TBD／缺欄位）
        // 就顯示「轉機時間待補」，不要整條隱藏消失讓人以為沒有轉機或誤以為漏填。
        const layoverLabel = (arrPrev, depNext) => formatLayover(arrPrev, depNext) || '轉機時間待補';
        // 確認碼預設遮蔽：裝置本地、不落 Firestore，每次重新整理都會重新蓋住
        const revealedFlightConfirmations = reactive({});
        const toggleFlightConfirmation = (segId) => { revealedFlightConfirmations[segId] = !revealedFlightConfirmations[segId]; };
        const maskConfirmation = () => '••••••';
        const shiftDateStr = (dateStr, offsetDays) => {
            if (!dateStr || !offsetDays) return dateStr;
            const [y, m, d] = dateStr.split('-').map(Number);
            const dt = new Date(y, m - 1, d + offsetDays);
            const mm = dt.getMonth() + 1, dd = dt.getDate(), yyyy = dt.getFullYear();
            return `${yyyy}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`;
        };
        // 舊版單航段格式（{type,startTime,startAirport,number,endTime,endAirport,arrivalOffset}）→ 新的多航段格式；資料不遺失
        const migrateFlightToSegments = (day) => {
            const old = day.flight;
            if (!old || old.segments) return; // 已是新格式或沒有航班資料
            day.flight = {
                id: generateId(),
                label: old.type === 'departure' ? '回程' : (old.type === 'arrival' ? '去程' : ''),
                segments: [{
                    id: generateId(), airline: '', flightNumber: old.number || '',
                    departureAirport: old.startAirport || '', arrivalAirport: old.endAirport || '',
                    departureDateTime: (day.fullDate && old.startTime) ? `${day.fullDate}T${old.startTime}` : '',
                    arrivalDateTime: (day.fullDate && old.endTime) ? `${shiftDateStr(day.fullDate, old.arrivalOffset || 0)}T${old.endTime}` : '',
                    departureTerminal: '', arrivalTerminal: '', confirmationNumber: '', notes: ''
                }]
            };
        };
        // 舊版 booking 的航班（type:'flight' 但只有通用的 title/date/time，沒有 journeyName/segments）→ 轉成新的多航段格式；
        // 原本存在 title 裡的內容（例如使用者誤填的 BR8）會搬進第一段的 flightNumber，不會遺失
        const migrateBookingFlightShape = (b) => {
            if (b.type !== 'flight' || b.segments) return;
            b.journeyName = b.title || '';
            b.segments = [{
                id: generateId(), airline: '', flightNumber: b.title || '', departureAirport: '', arrivalAirport: '',
                departureDate: b.date || '', departureTime: b.time || '', arrivalDate: '', arrivalTime: '',
                departureTerminal: '', arrivalTerminal: '', segmentNotes: ''
            }];
        };
        const getDotColor = (t) => { if (t === 'food') return 'bg-orange-400 border-orange-100 ring-2 ring-orange-50'; if (t === 'shop') return 'bg-pink-400 border-pink-100 ring-2 ring-pink-50'; if (t === 'transport' || t === 'flight') return 'bg-blue-500 border-blue-100 ring-2 ring-blue-50'; if (t === 'hotel') return 'bg-indigo-400 border-indigo-100 ring-2 ring-indigo-50'; if (t === 'conference') return 'bg-violet-500 border-violet-100 ring-2 ring-violet-50'; return 'bg-primary-500 border-primary-100 ring-2 ring-primary-50'; };
        const ITEM_TYPE_LABELS = { spot: '景點', food: '餐廳', shop: '購物', transport: '交通', hotel: '飯店', conference: '會議' };
        const itemTypeLabel = (t) => ITEM_TYPE_LABELS[t] || '景點';

        // ---- 匯入行程文字（同伴 AI 產生的純文字行程，貼上後解析成 itinerary items 或航班 booking）--------------
        // 刻意不追求完美解析：AI 產生的格式五花八門，這裡只抓最常見的骨架（日期標題 / 條列 / 時間開頭 / 航班段），
        // 抓不到的欄位（例如 notes）留空讓使用者自己在既有的編輯彈窗補，不在這裡硬做語意分析。
        // 航班文字（有航班號＋機場代碼＋時間）會整批分流出去，走 booking type:'flight'（跟航班資訊卡片同一份資料），
        // 不會混進每日 timeline 的一般 itinerary items——這是這次修改的重點，之前誤把航班行拆成一般行程。
        const TEXT_IMPORT_DATE_SEP = '[|｜:：,、\\-]';
        const DATE_HEADER_FULL_RE = new RegExp(`^(?:day\\s*\\d+\\s*${TEXT_IMPORT_DATE_SEP}\\s*)?(\\d{4})[\\/\\-](\\d{1,2})[\\/\\-](\\d{1,2})\\s*(?:[\\(（][^\\)）]*[\\)）])?\\s*[:：]?\\s*$`, 'i');
        const DATE_HEADER_SHORT_RE = new RegExp(`^(?:day\\s*\\d+\\s*${TEXT_IMPORT_DATE_SEP}\\s*)?(\\d{1,2})[\\/\\-](\\d{1,2})\\s*(?:[\\(（][^\\)）]*[\\)）])?\\s*[:：]?\\s*$`, 'i');
        const TEXT_IMPORT_TIME_RE = /^(\d{1,2}:\d{2})\s*[:：\-]?\s*/;
        const stripImportBullet = (line) => line.replace(/^\s*(?:[-•*▪‣]|\d+[.\)、])\s*/, '').trim();
        const TEXT_IMPORT_TYPE_RULES = [
            { type: 'hotel', re: /hotel|飯店|旅館|inn\b|resort|check-?in|check-?out|入住|退房/i },
            { type: 'food', re: /早餐|午餐|晚餐|晚宴|brunch|breakfast|lunch|dinner|餐廳|restaurant|café|cafe|咖啡|甜點|dessert|美食/i },
            { type: 'conference', re: /會議|研討會|session|keynote|poster|conference|symposium|workshop|panel|演講|報告|摘要|abstract|報到|registration/i },
            { type: 'shop', re: /購物|shopping|outlet|市集|market|mall|超市|supermarket|藥妝|藥局/i },
            { type: 'transport', re: /機場|airport|抵達|出發|前往|departure|arrival|flight|航班|transfer|接送|taxi|uber|巴士|\bbus\b|地鐵|捷運|火車|train|渡輪|ferry|租車|rental car|開車|arrive|depart/i },
        ];
        const detectImportItemType = (text) => { for (const rule of TEXT_IMPORT_TYPE_RULES) { if (rule.re.test(text)) return rule.type; } return 'spot'; };

        // ---- 航班文字偵測與解析 --------------------------------------------------------------------------
        // 支援兩種格式：
        // (1) 單行式：「BR08｜TPE 10:15 → SFO 06:35」，航班號＋兩個機場＋兩個時間＋箭頭全部在同一行。
        // (2) 多行式（同伴 AI 更常見的寫法）：航班號(＋航空公司)一行、出發機場(＋Terminal)+時間一行、
        //     抵達機場(＋Terminal)+時間一行，三行一組；前面可以有一行「日期 + 去程/回程 + 航線」當標題，
        //     例如「2026/10/14 去程 Taipei to San Diego」或「去程｜Taipei → San Diego」。
        // 判斷「這一行是不是航班的一部分」用很窄的形狀比對（航班號／機場代碼＋時間／Terminal／去程回程標題／轉機備註）；
        // 一旦判斷進了航班區塊，裡面的行完全不會再拿去跑一般行程解析——就算某一段解析不完整，也只標記「無法完整解析」
        // 顯示提示，不會把航班的殘骸行（例如「BR08 EVA Air」）當成一般行程塞進 timeline（這是這次要修的問題）。
        const OLD_FLIGHT_SEGMENT_RE = /^([A-Za-z]{2,3})\s?(\d{1,4})\s*[|｜:：\-]?\s*([A-Za-z]{3})\s+(\d{1,2}:\d{2})\s*(?:→|->|-|to)\s*([A-Za-z]{3})\s+(\d{1,2}:\d{2})\s*(\+1)?\s*$/i;
        const FLIGHT_HEADER_RE = new RegExp(
            `^(?:(\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}|\\d{1,2}[\\/\\-]\\d{1,2})\\s*)?` +
            `[\\(（]?\\s*(去程|回程|outbound|inbound|departure|return)\\s*[\\)）]?` +
            `\\s*(?:[|｜:：\\-]?\\s*(.*))?$`, 'i'
        );
        // 機場／時間行：支援「機場代碼 [Terminal X] [日期] 時間 [+1] [出發|抵達]」各種排列組合的其中一部分同時出現，
        // 日期可有可無（沒有就交給 finalizeJourney 用 header 日期或前一段的抵達日期往下推）；
        // Terminal 關鍵字中英文都收（Terminal / 航廈 / Term.）；出發/抵達只是辨識用，不影響誰是出發誰是抵達
        // （順序固定：一組航段裡先出現的算出發，後出現的算抵達，跟三種範例格式一致）。
        const FLIGHT_AIRPORT_TIME_RE = /^([A-Za-z]{3})\s*(?:(?:terminal|航廈|term\.?)\s*(\S+?),?)?\s*(?:(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2})\s+)?(\d{1,2}:\d{2})\s*(\+1)?\s*(?:出發|抵達|departure|arrival|dep\.?|arr\.?)?\s*$/i;
        // 航班號行：「AS453」或「AS453 Alaska Airlines」都吃，後面那段文字（如果有）當航空公司名稱；
        // 沒有文字的話（格式 C：航班號自己一行）就留白，交給下一行「純航空公司名稱」的行去補（見 parseImportText），
        // 兩者都沒有的話最後在組裝航段時用 AIRLINE_CODE_NAMES 依代碼猜一個
        const FLIGHT_NUMBER_LINE_RE = /^([A-Za-z]{2,3})\s?(\d{1,4})\s*(.*)$/;
        // 單獨一行的航空公司名稱（格式 C）：只允許中英文字母/空白/常見標點，不含數字，避免誤吃機場時間行或航班號行
        const AIRLINE_NAME_LINE_RE = /^[A-Za-z一-鿿][A-Za-z一-鿿\s.\-]{1,40}$/;
        const FLIGHT_LAYOVER_NOTE_RE = /^(轉機|layover|transfer|停留)/i;
        const AIRLINE_CODE_NAMES = {
            BR: 'EVA Air', AS: 'Alaska Airlines', CI: 'China Airlines', CX: 'Cathay Pacific',
            UA: 'United Airlines', DL: 'Delta Air Lines', AA: 'American Airlines', BA: 'British Airways',
            JL: 'Japan Airlines', NH: 'ANA', KE: 'Korean Air', OZ: 'Asiana Airlines', SQ: 'Singapore Airlines',
        };
        const normalizeDateToken = (token, yearCtx) => {
            if (!token) return '';
            const parts = token.split(/[\/\-]/).map(s => s.trim());
            if (parts.length === 3) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
            if (parts.length === 2) return `${yearCtx}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
            return '';
        };
        const inferJourneyDirection = (keyword) => {
            if (/去程|outbound|departure/i.test(keyword)) return 'outbound';
            if (/回程|inbound|return/i.test(keyword)) return 'inbound';
            return 'custom';
        };
        // 判斷單一行屬於航班的哪一種子形狀；不符合任何一種就回傳 kind: null（表示這行跟航班無關）
        const classifyFlightSubLine = (line) => {
            let m = line.match(OLD_FLIGHT_SEGMENT_RE);
            if (m) {
                const airlineCode = m[1].toUpperCase();
                return {
                    kind: 'oldsegment', data: {
                        airline: AIRLINE_CODE_NAMES[airlineCode] || '', flightNumber: `${airlineCode}${m[2]}`,
                        departureAirport: m[3].toUpperCase(), departureTerminal: '', departureTime: m[4], departureDateRaw: '',
                        arrivalAirport: m[5].toUpperCase(), arrivalTerminal: '', arrivalTime: m[6], arrivalDateRaw: '',
                        arrivalPlusOne: !!m[7],
                    }
                };
            }
            if (FLIGHT_LAYOVER_NOTE_RE.test(line)) return { kind: 'layover' };
            m = line.match(FLIGHT_HEADER_RE);
            if (m) {
                const keyword = m[2];
                const rest = (m[3] || '').trim();
                const direction = inferJourneyDirection(keyword);
                const directionLabel = direction === 'outbound' ? '去程' : direction === 'inbound' ? '回程' : keyword;
                return { kind: 'header', data: { rawDate: m[1] || '', direction, journeyName: rest ? `${directionLabel}｜${rest}` : directionLabel } };
            }
            m = line.match(FLIGHT_AIRPORT_TIME_RE);
            if (m) return { kind: 'airporttime', data: { airport: m[1].toUpperCase(), terminal: m[2] || '', date: m[3] || '', time: m[4], plusOne: !!m[5] } };
            m = line.match(FLIGHT_NUMBER_LINE_RE);
            if (m) {
                const code = m[1].toUpperCase();
                // 航空公司優先順序：這一行自己帶的文字（格式 A/B）> 之後單獨一行的航空公司名稱（格式 C，見 parseImportText）
                // > 都沒有的話留白，最後組裝航段時才用 AIRLINE_CODE_NAMES 依代碼猜——刻意延後猜測，
                // 這樣格式 C 裡緊接著的「Alaska Airlines」這種單獨一行才有機會蓋掉猜測，而不是被略過。
                return { kind: 'flightnum', data: { flightNumber: `${code}${m[2]}`, airlineCode: code, airline: (m[3] || '').trim() } };
            }
            return { kind: null };
        };
        // 這一行本身像不像「一般行程」（日期標題／時間開頭／條列項目）：用來判斷航班區塊該不該在這一行結束
        const looksLikeItineraryLine = (line) => DATE_HEADER_FULL_RE.test(line) || DATE_HEADER_SHORT_RE.test(line)
            || TEXT_IMPORT_TIME_RE.test(line) || /^\s*(?:[-•*▪‣]|\d+[.\)、])\s*\S/.test(line);

        // 單一函式同時處理「一般行程」跟「航班」兩種內容，逐行掃描、依當下狀態分流（需求：同一段貼上文字可以混著寫）。
        // 航班區塊用一個小狀態機組裝：header 開新的 journey；flightnum 開一個新航段等機場/時間；
        // airporttime 依序當成該航段的出發／抵達；layover 直接忽略；轉機區塊裡任何看不懂、且不像一般行程的行，
        // 標記 malformed 但不外流成一般行程；只有真的像一般行程的行（日期標題/時間開頭/條列）才會結束航班區塊。
        const parseImportText = (rawText) => {
            const lines = rawText.split(/\r?\n/).map(l => l.trim());
            const tripStart = setup.value.startDate || '';
            const tripEnd = tripStart ? shiftDateStr(tripStart, (Number(setup.value.days) || 1) - 1) : '';
            let yearCtx = tripStart.split('-')[0] || String(new Date().getFullYear());
            let currentDateISO = null;
            let journey = null;
            const flightJourneys = [];
            const flightParseWarnings = [];
            const itineraryRows = [];

            const startJourney = (headerData = null) => ({
                journeyName: headerData ? headerData.journeyName : '',
                direction: headerData ? headerData.direction : 'custom',
                headerDate: headerData ? normalizeDateToken(headerData.rawDate, yearCtx) : '',
                contextDate: currentDateISO,
                segments: [], pendingFlightNum: null, pendingDeparture: null, malformed: false,
            });
            // 組裝航段的日期：優先用該行自己寫的日期（departureDateRaw/arrivalDateRaw），沒寫的話：
            // - 出發日期 fallback 用「目前推進到的日期」（header 日期，或上一段抵達日期），不需要特別提示——
            //   這是使用者本來就沒打算每段都重複寫日期的正常寫法（需求 3）。
            // - 抵達日期 fallback：有寫 +1 就用出發日期加一天；否則沒有任何線索，才用出發日期頂著，
            //   並在 segmentNotes 記一筆「Arrival date inferred; please verify.」讓使用者自己核對（需求 4），
            //   不會因為抓不到抵達日期就整段丟棄或讓匯入失敗。
            const finalizeJourney = () => {
                if (!journey) return;
                if (journey.pendingFlightNum) journey.malformed = true; // 有航班號但沒配到完整的兩段機場/時間
                if (!journey.segments.length) {
                    flightParseWarnings.push('偵測到航班資訊，但無法完整解析。請改用航班新增表單或調整格式。');
                    journey = null;
                    return;
                }
                const anchor = journey.headerDate || journey.contextDate || (journey.direction === 'outbound' ? tripStart : journey.direction === 'inbound' ? tripEnd : '') || '';
                let runningDate = anchor;
                let dateInferred = false;
                const segments = journey.segments.map(raw => {
                    const departureDate = raw.departureDateRaw ? normalizeDateToken(raw.departureDateRaw, yearCtx) : (runningDate || '');
                    let arrivalDate = raw.arrivalDateRaw ? normalizeDateToken(raw.arrivalDateRaw, yearCtx) : '';
                    let segmentNotes = '';
                    if (!arrivalDate) {
                        if (raw.arrivalPlusOne && departureDate) {
                            arrivalDate = shiftDateStr(departureDate, 1);
                        } else if (raw.arrivalTime && departureDate) {
                            arrivalDate = departureDate;
                            segmentNotes = 'Arrival date inferred; please verify.';
                            dateInferred = true;
                        }
                    }
                    runningDate = arrivalDate || departureDate || runningDate;
                    return {
                        id: generateId(),
                        airline: raw.airline || AIRLINE_CODE_NAMES[raw.airlineCode] || '',
                        flightNumber: raw.flightNumber,
                        departureAirport: raw.departureAirport, arrivalAirport: raw.arrivalAirport,
                        departureDate, departureTime: raw.departureTime, arrivalDate, arrivalTime: raw.arrivalTime,
                        departureTerminal: raw.departureTerminal || '', arrivalTerminal: raw.arrivalTerminal || '', segmentNotes,
                    };
                });
                const journeyName = journey.journeyName || `${segments[0].departureAirport} → ${segments[segments.length - 1].arrivalAirport}`;
                flightJourneys.push({ _journeyId: generateId(), journeyName, direction: journey.direction, segments, incomplete: journey.malformed, dateInferred });
                // 航班解析成功後，把「目前日期」推進到最後一段抵達的那天：使用者常常直接接著寫當天的行程
                // （例如落地當天的「16:00 La Jolla Cove」），沒有另外重覆一次日期標題，讓後面沒寫日期的行程行能掛對天
                const lastArrivalDate = segments[segments.length - 1].arrivalDate;
                if (lastArrivalDate) currentDateISO = lastArrivalDate;
                journey = null;
            };

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;

                const cls = classifyFlightSubLine(line);
                if (cls.kind === 'header') { finalizeJourney(); journey = startJourney(cls.data); continue; }
                if (cls.kind === 'oldsegment') { if (!journey) journey = startJourney(); journey.segments.push(cls.data); continue; }
                if (cls.kind === 'layover') continue;
                if (cls.kind === 'flightnum') {
                    if (!journey) journey = startJourney();
                    if (journey.pendingFlightNum) journey.malformed = true; // 上一個航班號還沒配到完整段落又來一個新的
                    journey.pendingFlightNum = cls.data; journey.pendingDeparture = null;
                    continue;
                }
                // 格式 C：航班號跟航空公司名稱分開兩行（「AS453」下一行「Alaska Airlines」）。只在「剛看到一個
                // 還沒帶航空公司名稱的航班號、還沒開始配機場/時間」這個窄窗口內才把整行文字當航空公司名稱，
                // 避免誤吃其他一般文字；符合條件但不像航空公司名稱的行，交給下面正常流程判斷。
                if (journey && journey.pendingFlightNum && !journey.pendingFlightNum.airline && !journey.pendingDeparture
                    && cls.kind === null && AIRLINE_NAME_LINE_RE.test(line)) {
                    journey.pendingFlightNum.airline = line.trim();
                    continue;
                }
                if (cls.kind === 'airporttime') {
                    if (!journey || !journey.pendingFlightNum) { if (journey) journey.malformed = true; continue; }
                    if (!journey.pendingDeparture) { journey.pendingDeparture = cls.data; }
                    else {
                        journey.segments.push({
                            flightNumber: journey.pendingFlightNum.flightNumber,
                            airline: journey.pendingFlightNum.airline || AIRLINE_CODE_NAMES[journey.pendingFlightNum.airlineCode] || '',
                            departureAirport: journey.pendingDeparture.airport, departureTerminal: journey.pendingDeparture.terminal,
                            departureTime: journey.pendingDeparture.time, departureDateRaw: journey.pendingDeparture.date,
                            arrivalAirport: cls.data.airport, arrivalTerminal: cls.data.terminal,
                            arrivalTime: cls.data.time, arrivalDateRaw: cls.data.date, arrivalPlusOne: cls.data.plusOne,
                        });
                        journey.pendingFlightNum = null; journey.pendingDeparture = null;
                    }
                    continue;
                }

                // 這一行不符合任何航班子形狀
                if (journey && !looksLikeItineraryLine(line)) { journey.malformed = true; continue; }
                finalizeJourney(); // 看起來是一般行程了（或本來就沒有正在組的 journey），結束航班區塊

                let m = line.match(DATE_HEADER_FULL_RE);
                if (m) { yearCtx = m[1]; currentDateISO = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; continue; }
                m = line.match(DATE_HEADER_SHORT_RE);
                if (m) { currentDateISO = `${yearCtx}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; continue; }
                const stripped = stripImportBullet(line);
                if (!stripped) continue;
                let time = '', rest = stripped;
                const tm = stripped.match(TEXT_IMPORT_TIME_RE);
                if (tm) {
                    const [h, mi] = tm[1].split(':');
                    time = `${h.padStart(2, '0')}:${mi}`;
                    rest = stripped.slice(tm[0].length).trim();
                }
                const title = (rest || stripped).trim();
                if (!title) continue;
                itineraryRows.push({ _rowId: generateId(), date: currentDateISO, time, title, type: detectImportItemType(line), note: '' });
            }
            finalizeJourney();
            return { itineraryRows, flightJourneys, flightParseWarnings };
        };
        // 把解析結果對到目前旅程的 days（依 fullDate 找天），標出「日期不在旅程範圍」跟「同天同時間同標題已存在」，
        // 兩者都預設不勾選匯入——前者沒有可以掛的一天，後者讓使用者自己決定要不要仍然重複匯入
        const buildImportPreview = (rows) => rows.map(r => {
            const dayIdx = r.date ? days.value.findIndex(d => d.fullDate === r.date) : -1;
            const outOfRange = dayIdx === -1;
            const duplicate = !outOfRange && (days.value[dayIdx].items || []).some(i => (i.time || '') === (r.time || '') && (i.activity || '').trim() === r.title.trim());
            return {
                ...r, dayIdx, outOfRange, duplicate,
                dayLabel: outOfRange ? (r.date || '未偵測到日期') : `Day ${dayIdx + 1}｜${days.value[dayIdx].shortDate || days.value[dayIdx].date}`,
                include: !outOfRange && !duplicate,
            };
        });
        // 重複判斷：同一個 trip 的 bookings 裡，任何 flight booking 的任何一段有相同 flightNumber + departureDate + departureTime
        const flightSegmentExists = (seg) => bookings.value.some(b => b.type === 'flight' && (b.segments || []).some(s =>
            (s.flightNumber || '').replace(/\s+/g, '').toUpperCase() === (seg.flightNumber || '').replace(/\s+/g, '').toUpperCase()
            && s.departureDate === seg.departureDate && s.departureTime === seg.departureTime
        ));
        const buildFlightImportPreview = (journeys) => journeys.map(j => {
            const duplicate = j.segments.some(flightSegmentExists);
            return { ...j, duplicate, include: !duplicate };
        });
        const textImportModal = reactive({ show: false, step: 'paste', text: '', items: [], flightJourneys: [], flightParseWarnings: [] });
        const lastImportBatch = ref(null);
        const openTextImportModal = () => {
            textImportModal.step = 'paste'; textImportModal.text = ''; textImportModal.items = [];
            textImportModal.flightJourneys = []; textImportModal.flightParseWarnings = [];
            textImportModal.show = true;
        };
        const closeTextImportModal = () => { textImportModal.show = false; };
        const backToPasteStep = () => { textImportModal.step = 'paste'; };
        // 給使用者複製去餵給自己的 AI（ChatGPT/Claude…）的提示詞：把上面那段「跟人類解釋解析規則」的說明
        // 改寫成「跟 AI 下指令」的格式，讓 AI 生成的文字本身就長得像這個匯入器看得懂的樣子
        // （日期標題／條列／時間開頭／航班段），不用使用者自己事後對照規則手動調格式。
        const TEXT_IMPORT_PROMPT = `請生成可匯入旅遊 App 的 .txt 純文字行程：日期一行、行程逐行列出、包含時間與地點，不要表格。

格式規則：
- 每天的行程用一行日期標題開頭，例如 2026/10/14、10/14、或 Day 1｜10/14。
- 行程項目逐行列出，每行開頭是時間（例如 09:00），接著是地點與活動說明；沒有明確時間的項目也可以，直接寫地點與說明。
- 可以用 -、•、1. 等條列符號開頭，也可以不用。
- 航班請另外獨立列成一段，不要跟每日行程混在一起：可以用單行格式（例如 BR08｜TPE 10:15 → SFO 06:35），也可以把航班號／航空公司、出發機場＋時間、抵達機場＋時間分開寫成多行。
- 不要用表格、不要用 Markdown 語法（例如 |---|---| 或 **粗體**），純文字就好。`;
        const copyTextImportPrompt = async () => {
            try {
                await navigator.clipboard.writeText(TEXT_IMPORT_PROMPT);
                showToast('提示詞已複製，貼給你的 AI 就能產生行程文字', { icon: 'ph-bold ph-clipboard-text' });
            } catch (e) {
                appConfirm('自動複製失敗，請長按下方文字手動複製：', { title: '匯入提示詞', link: TEXT_IMPORT_PROMPT, showCancel: false, confirmText: '關閉' });
            }
        };
        const previewTextImport = () => {
            const text = textImportModal.text.trim();
            if (!text) { showToast('請先貼上行程文字', { icon: 'ph-bold ph-warning' }); return; }
            const { itineraryRows, flightJourneys, flightParseWarnings } = parseImportText(text);
            if (!itineraryRows.length && !flightJourneys.length && !flightParseWarnings.length) { showToast('無法辨識任何行程或航班內容，請確認格式', { icon: 'ph-bold ph-warning' }); return; }
            textImportModal.items = buildImportPreview(itineraryRows);
            textImportModal.flightJourneys = buildFlightImportPreview(flightJourneys);
            textImportModal.flightParseWarnings = flightParseWarnings;
            textImportModal.step = 'preview';
        };
        const toggleAllImportRows = () => {
            const importable = textImportModal.items.filter(i => !i.outOfRange);
            const allChecked = importable.every(i => i.include);
            importable.forEach(i => { i.include = !allChecked; });
        };
        const toggleAllFlightJourneys = () => {
            const allChecked = textImportModal.flightJourneys.every(j => j.include);
            textImportModal.flightJourneys.forEach(j => { j.include = !allChecked; });
        };
        // 只新增，不覆蓋、不刪除既有資料；每筆都標上 source/importedAt/importBatchId，方便日後辨識或撤回。
        // 航班一律走 createBookingDraftForType('flight', ...) 補齊完整欄位（含記帳/同步用的欄位）；
        // syncToItinerary 開啟（對 flight 來說意思是「投影到航班資訊卡片」，不是建立一般 timeline item，
        // 見 syncFlightBookingToFlightInfo），這樣文字匯入的航班會直接出現在航班資訊，不用使用者手動再勾一次。
        // syncToExpense 維持關閉（工廠預設 false），避免匯入就無中生有一筆記帳金額。
        const confirmTextImport = () => {
            const toImportItems = textImportModal.items.filter(i => i.include && i.dayIdx !== -1);
            const toImportFlights = textImportModal.flightJourneys.filter(j => j.include);
            if (!toImportItems.length && !toImportFlights.length) { showToast('沒有勾選任何要匯入的項目', { icon: 'ph-bold ph-warning' }); return; }
            const batchId = generateId();
            const importedAt = new Date().toISOString();

            const touchedDayIdx = new Set();
            toImportItems.forEach(row => {
                const day = days.value[row.dayIdx];
                day.items.push({
                    id: generateId(), time: row.time || '', type: row.type, activity: row.title,
                    location: '', link: '', note: row.note || '',
                    source: 'text-import', importedAt, importBatchId: batchId,
                });
                touchedDayIdx.add(row.dayIdx);
            });
            touchedDayIdx.forEach(idx => sortItemsByTime(days.value[idx].items));

            toImportFlights.forEach(j => {
                const draft = createBookingDraftForType('flight', { journeyName: j.journeyName, segments: j.segments, syncToItinerary: true });
                draft.direction = j.direction;
                draft.source = 'text-import'; draft.importedAt = importedAt; draft.importBatchId = batchId;
                bookings.value.push(draft);
                syncFlightBookingToFlightInfo(draft);
            });

            lastImportBatch.value = { id: batchId, itemCount: toImportItems.length, flightCount: toImportFlights.length, at: importedAt };
            textImportModal.show = false;
            const parts = [];
            if (toImportItems.length) parts.push(`${toImportItems.length} 筆行程`);
            if (toImportFlights.length) parts.push(`${toImportFlights.length} 筆航班`);
            showToast(`已匯入${parts.join('、')}`, { icon: 'ph-bold ph-check-circle' });
        };
        // 單層復原（不是完整的復原堆疊）：撤回會移除「所有天」裡 importBatchId 相符的行程項目，以及 bookings 裡相符的航班，
        // 足夠應付「這批匯錯了」的情境
        const undoLastImport = async () => {
            if (!lastImportBatch.value) return;
            const batchId = lastImportBatch.value.id;
            const totalCount = (lastImportBatch.value.itemCount || 0) + (lastImportBatch.value.flightCount || 0);
            const ok = await appConfirm(`確定要撤回上一次匯入的 ${totalCount} 筆內容嗎？（含行程與航班）`, { title: '撤回匯入', confirmText: '撤回', danger: true });
            if (!ok) return;
            let removedItems = 0;
            days.value.forEach(day => {
                if (!day.items || !day.items.length) return;
                const before = day.items.length;
                day.items = day.items.filter(i => i.importBatchId !== batchId);
                removedItems += before - day.items.length;
            });
            const beforeBookingsCount = bookings.value.length;
            const removedFlightBookings = bookings.value.filter(b => b.importBatchId === batchId && b.type === 'flight');
            bookings.value = bookings.value.filter(b => b.importBatchId !== batchId);
            removedFlightBookings.forEach(b => removeGeneratedFlightInfo(b.id));
            const removedFlights = beforeBookingsCount - bookings.value.length;
            lastImportBatch.value = null;
            showToast(`已撤回 ${removedItems} 筆行程、${removedFlights} 筆航班`, { icon: 'ph-bold ph-arrow-counter-clockwise' });
        };
        const updateParticipants = () => { participants.value = participantsStr.value.split(',').map(s => s.trim()).filter(s => s); };
        const isUrl = (str) => { if (!str) return false; try { new URL(str); return true; } catch { return /^https?:\/\//i.test(str); } };

        // ---- 新增/編輯統一走底部彈窗（draft 草稿制：儲存才寫回，取消不留痕）----
        const sortItemsByTime = (items) => items.sort((a, b) => {
            if (!a.time && !b.time) return 0;
            if (!a.time) return 1;
            if (!b.time) return -1;
            return a.time.localeCompare(b.time);
        });

        // 行程項目彈窗
        const itemModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openItemModal = (item = null) => {
            if (item) {
                itemModal.mode = 'edit'; itemModal.targetId = item.id;
                itemModal.draft = JSON.parse(JSON.stringify(item));
            } else {
                itemModal.mode = 'add'; itemModal.targetId = null;
                itemModal.draft = { id: generateId(), time: '', type: 'spot', activity: '', location: '', link: '', note: '' };
            }
            itemModal.show = true;
            if (!item) nextTick(() => { document.querySelector('.js-item-activity')?.focus(); });
        };
        const saveItemModal = () => {
            const day = days.value[currentDayIdx.value];
            if (!day) { itemModal.show = false; return; }
            if (itemModal.mode === 'edit') {
                const target = day.items.find(i => i.id === itemModal.targetId);
                if (target) Object.assign(target, itemModal.draft);
            } else {
                day.items.push({ ...itemModal.draft });
            }
            sortItemsByTime(day.items); // 保留鐵則：完成編輯後依時間自動排序
            itemModal.show = false;
        };
        const deleteItemFromModal = () => {
            const day = days.value[currentDayIdx.value];
            itemModal.show = false;
            if (!day) return;
            const idx = day.items.findIndex(i => i.id === itemModal.targetId);
            if (idx === -1) return;
            const removed = day.items.splice(idx, 1)[0];
            showToast('已刪除行程', { icon: 'ph-bold ph-trash', undo: () => { day.items.splice(Math.min(idx, day.items.length), 0, removed); } });
        };

        const addDay = () => days.value.push({ date: `Day ${days.value.length + 1}`, title: '', items: [] });

        // 口袋名單彈窗
        const locModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openLocModal = (loc = null) => {
            if (loc) {
                locModal.mode = 'edit'; locModal.targetId = loc.id;
                locModal.draft = JSON.parse(JSON.stringify(loc));
                if (!locModal.draft.type) locModal.draft.type = 'spot';
            } else {
                locModal.mode = 'add'; locModal.targetId = null;
                locModal.draft = { id: generateId(), name: '', type: 'spot', link: '', note: '', prefs: {} };
            }
            locModal.show = true;
            if (!loc) nextTick(() => { document.querySelector('.js-loc-name')?.focus(); });
        };
        const saveLocModal = () => {
            if (locModal.mode === 'edit') {
                const target = savedLocations.value.find(l => l.id === locModal.targetId);
                // prefs 是各旅伴直接點卡片上的按鈕存的（見 setLocPref），itineraryDayIdx/itineraryItemId 是加入行程按鈕存的，
                // 兩者都不透過這個編輯彈窗；排除它們再 assign，避免拿彈窗打開當下的舊快照蓋掉旅伴同時做的操作
                if (target) { const { prefs, itineraryDayIdx, itineraryItemId, ...rest } = locModal.draft; Object.assign(target, rest); }
            } else {
                savedLocations.value.push({ ...locModal.draft });
            }
            locModal.show = false;
        };
        const deleteLocFromModal = () => {
            locModal.show = false;
            const idx = savedLocations.value.findIndex(l => l.id === locModal.targetId);
            if (idx === -1) return;
            const target = savedLocations.value[idx];
            if (isLocInItinerary(target)) removeLocFromItinerary(target);
            const removed = savedLocations.value.splice(idx, 1)[0];
            showToast('已刪除地點', { icon: 'ph-bold ph-trash', undo: () => { savedLocations.value.splice(Math.min(idx, savedLocations.value.length), 0, removed); } });
        };

        // ---- 口袋名單一鍵加入行程：地點本身沒有日期，所以要先挑要排進哪一天；
        // 跟「我的 ASA 議程」（isSessionInItinerary 那組）同一套 itineraryDayIdx/itineraryItemId 掛勾慣例，
        // 差別只在 session 已經有固定日期可以直接加，口袋名單地點要跳個選日彈窗讓使用者選。----
        const isLocInItinerary = (loc) => {
            if (loc.itineraryDayIdx == null || !loc.itineraryItemId) return false;
            const day = days.value[loc.itineraryDayIdx];
            return !!(day && day.items.some(i => i.id === loc.itineraryItemId));
        };
        const locDayPicker = reactive({ show: false, locId: null });
        const openLocDayPicker = (loc) => { locDayPicker.locId = loc.id; locDayPicker.show = true; };
        const addLocToDay = (dayIdx) => {
            const loc = savedLocations.value.find(l => l.id === locDayPicker.locId);
            locDayPicker.show = false;
            if (!loc) return;
            const item = {
                id: generateId(), time: '', type: loc.type || 'spot',
                activity: loc.name || '未命名地點', location: '', link: loc.link || '', note: loc.note || ''
            };
            days.value[dayIdx].items.push(item);
            sortItemsByTime(days.value[dayIdx].items);
            loc.itineraryDayIdx = dayIdx;
            loc.itineraryItemId = item.id;
            showToast(`已加入 Day ${dayIdx + 1} 行程`, { icon: 'ph-bold ph-calendar-check' });
        };
        const removeLocFromItinerary = (loc) => {
            if (loc.itineraryDayIdx == null || !loc.itineraryItemId) return;
            const day = days.value[loc.itineraryDayIdx];
            if (day) {
                const idx = day.items.findIndex(i => i.id === loc.itineraryItemId);
                if (idx !== -1) day.items.splice(idx, 1);
            }
            loc.itineraryDayIdx = null; loc.itineraryItemId = null;
            showToast('已從行程移除（口袋名單裡還在）', { icon: 'ph-bold ph-calendar-x' });
        };

        // ---- 口袋名單偏好：地點本身共用，偏好依成員分開存在 loc.prefs[member]（不是投票/排行，只顯示各自意見）----
        // member 沿用專案既有識別方式（participants 的顯示名稱字串），跟記帳 payer、清單 checkedBy 是同一套 key，
        // 「目前是誰」沿用 activeChecklistMember（見旅遊清單）：同一裝置在整趟旅程只需選一次身份。
        const LOC_PREF_ORDER = ['want', 'maybe', 'no'];
        const LOC_PREF_META = {
            want: { label: '想去', emoji: '❤️', activeClass: 'bg-primary-500 border-primary-500 text-white', chipClass: 'bg-primary-50 text-primary-700 border border-primary-100' },
            maybe: { label: '備案', emoji: '🤔', activeClass: 'bg-amber-400 border-amber-400 text-white', chipClass: 'bg-amber-50 text-amber-700 border border-amber-100' },
            no: { label: '不想去', emoji: '🙅', activeClass: 'bg-stone-500 border-stone-500 text-white', chipClass: 'bg-stone-100 text-stone-500 border border-stone-200' },
        };
        // 點同一個偏好再點一次＝取消標記（回到「尚未標記」，不是投票不能反悔）
        const setLocPref = (loc, member, value) => {
            if (!member) return;
            if (!loc.prefs) loc.prefs = {};
            if (loc.prefs[member] === value) delete loc.prefs[member];
            else loc.prefs[member] = value;
        };
        // 其他旅伴的偏好摘要（含尚未標記），排除目前這個人自己
        const otherMemberPrefs = (loc) => checklistMembers.value
            .filter(m => m !== activeChecklistMember.value)
            .map(m => ({ member: m, pref: loc.prefs?.[m] || null }));
        // 共識提示：全部人都 want → 建議排入；有人 no → 需討論；有人 maybe（無 no）→ 可列備案；其餘（尚無人/部分尚未標記）不顯示
        const locConsensus = (loc) => {
            const members = checklistMembers.value;
            const voted = members.filter(m => loc.prefs?.[m]);
            if (!voted.length) return null;
            if (voted.some(m => loc.prefs[m] === 'no')) return { text: '有人不想去，需討論', cls: 'bg-stone-100 text-stone-600' };
            if (voted.some(m => loc.prefs[m] === 'maybe')) return { text: '有備案意見，可列為備案', cls: 'bg-amber-50 text-amber-700' };
            if (voted.length === members.length) return { text: '大家都想去，建議排入行程', cls: 'bg-primary-50 text-primary-700' };
            return null; // 目前都是 want，但還有人沒標記，先不下結論
        };

        // ---- 開新旅程：Blank Trip / ASA San Diego 2026 Template（僅在建立新旅程時可選，不影響既有旅程）----
        const newTripUseAsaTemplate = ref(false);
        const buildBlankDays = (startDate, dayCount) => {
            const dNames = ['日', '一', '二', '三', '四', '五', '六'];
            const [ny, nm, nd] = startDate.split('-').map(Number);
            const start = new Date(ny, nm - 1, nd);
            const built = [];
            for (let i = 0; i < dayCount; i++) {
                const curr = new Date(start); curr.setDate(start.getDate() + i);
                const mm = curr.getMonth() + 1; const dd = curr.getDate(); const yyyy = curr.getFullYear();
                built.push({
                    date: `${mm < 10 ? '0' + mm : mm}/${dd < 10 ? '0' + dd : dd} (${dNames[curr.getDay()]})`,
                    shortDate: `${mm}/${dd}`,
                    fullDate: `${yyyy}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`,
                    title: i === 0 ? '抵達 & 探索' : '行程規劃',
                    items: [], flight: null
                });
            }
            return built;
        };
        // 可重複使用的範本函式：把 ASA_SD_2026_ITINERARY 純資料展開成 days.value 需要的格式
        // 把範本裡沒有 id 的 journey/segments 補上 id，跟 seedChecklist 的套路一致
        const buildFlightJourney = (tpl) => ({ id: generateId(), label: tpl.label, segments: tpl.segments.map(s => ({ id: generateId(), ...s })) });
        const seedAsaSanDiego2026Days = () => {
            const dNames = ['日', '一', '二', '三', '四', '五', '六'];
            const itemsByDate = {};
            ASA_SD_2026_ITINERARY.forEach(entry => { (itemsByDate[entry.date] = itemsByDate[entry.date] || []).push(entry); });
            const flightsByDate = {};
            [ASA_SD_2026_FLIGHTS.outbound, ASA_SD_2026_FLIGHTS.return].forEach(j => { flightsByDate[j.date] = j; });
            const [ny, nm, nd] = ASA_SD_2026_TRIP_DEFAULTS.startDate.split('-').map(Number);
            const start = new Date(ny, nm - 1, nd);
            const built = [];
            for (let i = 0; i < ASA_SD_2026_TRIP_DEFAULTS.days; i++) {
                const curr = new Date(start); curr.setDate(start.getDate() + i);
                const mm = curr.getMonth() + 1; const dd = curr.getDate(); const yyyy = curr.getFullYear();
                const fullDate = `${yyyy}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`;
                built.push({
                    date: `${mm < 10 ? '0' + mm : mm}/${dd < 10 ? '0' + dd : dd} (${dNames[curr.getDay()]})`,
                    shortDate: `${mm}/${dd}`,
                    fullDate,
                    title: i === 0 ? '抵達 & 探索' : '行程規劃',
                    items: (itemsByDate[fullDate] || []).map(e => ({
                        id: generateId(), time: e.time, type: e.type, activity: e.activity, location: '', link: '', note: e.note || ''
                    })),
                    flight: flightsByDate[fullDate] ? buildFlightJourney(flightsByDate[fullDate]) : null
                });
            }
            return built;
        };
        const seedAsaSanDiego2026Poster = () => ({
            id: generateId(), name: ASA_SD_2026_POSTER.name, type: ASA_SD_2026_POSTER.type, link: '', note: ASA_SD_2026_POSTER.note, prefs: {}
        });
        // My Presentation 面板：日期/地點/海報編號等都還沒公布，先帶入標題跟備註，其餘留 TBD 讓使用者補
        const seedAsaSanDiego2026Presentation = () => ({
            title: ASA_SD_2026_POSTER.name, date: '', time: '', location: '', posterNumber: '',
            uploadDeadline: '', checkInRequirement: '', notes: ASA_SD_2026_POSTER.note
        });
        const seedAsaSanDiego2026Bookings = () => ASA_SD_2026_BOOKINGS.map(j => ({
            id: generateId(), type: j.type, journeyName: j.journeyName,
            confirmationNumber: j.confirmationNumber || '', bookedBy: j.bookedBy || '', notes: j.notes || '',
            segments: j.segments.map(s => ({ id: generateId(), ...s }))
        }));
        const useAsaSanDiego2026Template = () => {
            newTripUseAsaTemplate.value = true;
            Object.assign(setup.value, ASA_SD_2026_TRIP_DEFAULTS);
            if (weather.value) weather.value.location = ASA_SD_2026_TRIP_DEFAULTS.destination;
            // 範本直接用 Object.assign 設定 currency，不是使用者手動選 <select>，不會觸發它的 @change，
            // 匯率欄位就會停在建立新旅程時的預設值 1（也就是「1 USD ≈ 1 TWD」這個錯誤畫面）——
            // 這裡補一次真正的匯率抓取，跟使用者自己手動改幣別是同一條路徑。
            updateRateByCurrency();
        };
        const useBlankTripTemplate = () => {
            newTripUseAsaTemplate.value = false;
            setup.value = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google', isAsaTemplate: false };
            if (weather.value) weather.value.location = '';
        };

        // ---- 旅遊清單（項目共享、每人各勾各的；成員空時退化單一共用框 __shared__）----
        const seedChecklist = () => CHECKLIST_TEMPLATE.map(t => ({ ...t, id: generateId(), checkedBy: {} }));
        const seedDefaultChecklist = () => {
            checklist.value = seedChecklist();
            showToast(`已帶入預設清單（${CHECKLIST_TEMPLATE.length} 項）`, { icon: 'ph-bold ph-suitcase-rolling' });
        };
        const checklistMembers = computed(() => participants.value.length ? participants.value : ['__shared__']);
        const memberLabel = (m) => m === '__shared__' ? '' : m;
        // 「我是誰」：裝置本地偏好，依旅程分開存（不落 Firestore，不會被旅伴看到或蓋掉）。
        // 只有在「有多個成員可選」時才需要使用者主動選一次；只有一個選項（單人旅程 / __shared__）就直接帶入，不用問。
        const activeChecklistMember = ref('');
        const checklistMemberStorageKey = () => currentTripId.value ? `wetravel_checklist_member_${currentTripId.value}` : null;
        const loadActiveChecklistMember = () => {
            const members = checklistMembers.value;
            const key = checklistMemberStorageKey();
            const saved = key ? localStorage.getItem(key) : '';
            if (saved && members.includes(saved)) { activeChecklistMember.value = saved; }
            else if (members.length === 1) { activeChecklistMember.value = members[0]; }
            else { activeChecklistMember.value = ''; } // 尚未選擇，畫面會顯示「這是誰的清單？」
        };
        watch(currentTripId, loadActiveChecklistMember, { immediate: true });
        watch(checklistMembers, () => {
            if (activeChecklistMember.value && !checklistMembers.value.includes(activeChecklistMember.value)) loadActiveChecklistMember();
            else if (!activeChecklistMember.value && checklistMembers.value.length === 1) activeChecklistMember.value = checklistMembers.value[0];
        });
        // 選擇/切換身份：只影響「我在這台裝置上是誰」，不會顯示或動到旅伴的勾選狀態
        const chooseChecklistMember = (m) => {
            activeChecklistMember.value = m;
            const key = checklistMemberStorageKey();
            if (key) localStorage.setItem(key, m);
        };
        const toggleCheck = (item, member) => {
            if (!item.checkedBy) item.checkedBy = {};
            item.checkedBy[member] = !item.checkedBy[member];
        };
        // 只算「目前這個人」自己的總進度，不列出其他成員，避免看到旅伴打包了多少
        const myChecklistProgress = computed(() => ({
            done: checklist.value.filter(i => i.checkedBy && i.checkedBy[activeChecklistMember.value]).length,
            total: checklist.value.length
        }));
        // 內建分類 + 這趟旅程自己加的分類，兩者合併給畫面用（新增項目時的分類選單、下面的分類清單）
        const allChecklistCategories = computed(() => [...CHECKLIST_CATEGORIES, ...customChecklistCategories.value]);
        // 分類進度跟著目前選中角色算（多人並排時代曾是「全員勾完才算」，已廢）
        const checklistByCategory = computed(() => allChecklistCategories.value
            .map(cat => {
                const items = checklist.value.filter(i => i.category === cat.slug);
                return { ...cat, items, done: items.filter(i => i.checkedBy && i.checkedBy[activeChecklistMember.value]).length };
            })
            .filter(cat => cat.items.length));
        const toggleCat = (slug) => { collapsedCats[slug] = !collapsedCats[slug]; };
        const addChecklistCategory = () => {
            const name = (window.prompt('新增分類名稱：') || '').trim();
            if (!name) return;
            if (allChecklistCategories.value.some(c => c.label === name)) {
                showToast('已經有同名分類了', { icon: 'ph-bold ph-warning' });
                return;
            }
            customChecklistCategories.value.push({ slug: 'cat_' + generateId(), label: name, emoji: '🏷️' });
        };

        // Chrome 偶發 bug：換頁淡入的 CSSTransition 凍結在 currentTime 0（fill backwards 持續蓋 opacity:0 → 整頁空白），
        // 且 Vue 已清完 transition class、殘留動畫不會自己消失。換頁後逾時檢查，卡住就取消殘留動畫自癒。
        watch(viewMode, () => {
            setTimeout(() => {
                document.querySelectorAll('.view-pane').forEach(el => {
                    if (getComputedStyle(el).opacity !== '1' && !/fade-(enter|leave)/.test(el.className)) {
                        el.getAnimations().forEach(a => a.cancel());
                    }
                });
            }, 400);
        });
        const resetChecklist = async () => {
            const m = activeChecklistMember.value;
            const who = memberLabel(m) ? `${memberLabel(m)} 的` : '你的';
            const ok = await appConfirm(`只會清空${who}勾選，項目保留，其他成員不受影響。`, { title: '重設勾選', danger: true, confirmText: '重設' });
            if (!ok) return;
            checklist.value.forEach(i => { if (i.checkedBy) delete i.checkedBy[m]; });
            showToast(`已重設${who}勾選`);
        };

        // 清單項目彈窗（draft 制，同行程/口袋/支出）
        const isCheckNameInvalid = ref(false);
        const checkModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openCheckModal = (item = null) => {
            isCheckNameInvalid.value = false;
            if (item) {
                checkModal.mode = 'edit'; checkModal.targetId = item.id;
                checkModal.draft = JSON.parse(JSON.stringify(item));
            } else {
                checkModal.mode = 'add'; checkModal.targetId = null;
                checkModal.draft = { id: generateId(), name: '', category: 'misc', luggage: 'any', note: '', checkedBy: {} };
            }
            checkModal.show = true;
            if (!item) nextTick(() => { document.querySelector('.js-check-name')?.focus(); });
        };
        const saveCheckModal = () => {
            if (!checkModal.draft.name.trim()) {
                isCheckNameInvalid.value = true;
                nextTick(() => { document.querySelector('.js-check-name')?.focus(); });
                return;
            }
            if (checkModal.mode === 'edit') {
                const target = checklist.value.find(i => i.id === checkModal.targetId);
                if (target) Object.assign(target, checkModal.draft);
            } else {
                checklist.value.push({ ...checkModal.draft });
            }
            checkModal.show = false;
        };
        const deleteCheckFromModal = () => {
            checkModal.show = false;
            const idx = checklist.value.findIndex(i => i.id === checkModal.targetId);
            if (idx === -1) return;
            const removed = checklist.value.splice(idx, 1)[0];
            showToast('已刪除項目', { icon: 'ph-bold ph-trash', undo: () => { checklist.value.splice(Math.min(idx, checklist.value.length), 0, removed); } });
        };

        // ============================================================================================
        // 記帳（Expenses）— 每一筆支出各自是 trips/{tripId}/expenses/{expenseId} 底下的獨立文件，
        // 不再是存在 trip 文件裡的一個大陣列欄位。
        //
        // 為什麼要改：舊版把整個 expenses 陣列存成 trip 文件的一個欄位，每次存檔都是「整份陣列」覆蓋過去。
        // 兩人若在同一個 1 秒 debounce 視窗內個別新增一筆支出，兩邊各自算出的本地陣列都缺對方那一筆，
        // 最後 setDoc 到 Firestore 的那一次全陣列覆蓋會讓「先存到的那筆」憑空消失——不是合併，是整欄互蓋。
        // 改成子集合後，两筆新增是兩份獨立文件的寫入，天生不會互相覆蓋；同一筆支出被兩人同時「編輯」時，
        // 則靠下面的 version 欄位做 optimistic concurrency 檢查（見 saveExpModal），偵測到衝突就提醒使用者，
        // 不會安靜蓋掉對方的修改。
        //
        // 每筆支出欄位：id、title、amount、currency、paidByMemberId、splitAmongMemberIds、splitMethod、
        // createdAt/createdByMemberId、updatedAt/updatedByMemberId、version、deleted/deletedAt/deletedByMemberId。
        // 「誰欠誰」不存在這裡——那是從未刪除的 expenses 即時算出來的（見上面 owedByPerson/settlementTransfers）。
        // ============================================================================================
        let unsubscribeExpenses = null;
        const subscribeExpenses = (tripId) => {
            if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
            expenses.value = [];
            unsubscribeExpenses = onSnapshot(collection(db, 'trips', tripId, 'expenses'), (snap) => {
                expenses.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            }, (error) => {
                console.error('Expenses listen error', error);
                syncStatus.value = 'error';
                showToast(firebaseErrorMessage(error, '無法讀取記帳資料'), { icon: 'ph-bold ph-warning', duration: 5000 });
            });
        };
        // 一次性搬遷：把舊版存在 trip 文件裡的 expenses 陣列，逐筆寫成子集合文件；完成後清掉舊欄位，
        // 避免以後又被拿去當真相讀。用「子集合已經有文件」當保護閘：已經搬過（或本來就是新旅程）就不再搬。
        // 已知限制：兩台裝置「剛好同時」第一次打開同一個舊旅程，理論上可能都判斷子集合是空的而各搬一次、
        // 造成重複匯入——機率很低且可事後手動刪除重複項，這裡不做分散式鎖，屬於刻意的最小修改取捨。
        const migrateLegacyExpensesIfNeeded = async (tripId, legacyArray) => {
            if (!db || !legacyArray || !legacyArray.length) return;
            try {
                const existing = await getDocs(collection(db, 'trips', tripId, 'expenses'));
                if (!existing.empty) return;
                const nowIso = new Date().toISOString();
                for (const old of legacyArray) {
                    if (!old) continue;
                    const payerId = ensureMemberRecord(old.payer);
                    const ref = doc(collection(db, 'trips', tripId, 'expenses'));
                    const amount = Number(old.amount) || 0;
                    // 需求 H：這批舊資料沒有任何歷史匯率可考——currency 若不是 TWD，不可以偷偷預設
                    // exchangeRateToTWD = 1（那就是這次要修的 bug 本身），只能標成「缺匯率」讓使用者事後補齊。
                    const legacyCurrency = setup.value.currency || 'USD';
                    const legacyIsTWD = legacyCurrency === 'TWD';
                    await setDoc(ref, {
                        title: old.item || '未命名支出',
                        category: 'other',
                        amount,
                        currency: legacyCurrency,
                        exchangeRateToTWD: legacyIsTWD ? 1 : null,
                        exchangeRateFetchedAt: null,
                        exchangeRateSource: legacyIsTWD ? 'same-currency' : 'manual',
                        exchangeRateLocked: true,
                        summaryCurrency: 'TWD',
                        paidByMemberId: payerId,
                        splitAmongMemberIds: members.value.map(m => m.id),
                        splitMethod: 'equal',
                        customSplits: {},
                        notes: '',
                        sourceBookingId: null,
                        createdAt: old.date ? `${old.date}T00:00:00.000Z` : nowIso,
                        createdByMemberId: payerId,
                        updatedAt: nowIso,
                        updatedByMemberId: payerId,
                        version: 1,
                        deleted: false, deletedAt: null, deletedByMemberId: null,
                    });
                }
                // merge:true 只清掉這個欄位，不動同一份文件裡的其他欄位（days/checklist/setup...）
                await setDoc(doc(db, 'trips', tripId), { expenses: deleteField() }, { merge: true });
            } catch (e) {
                console.error('Migrate legacy expenses failed', e);
            }
        };

        // 記帳：快速新增保留內聯表單；既有支出點列開彈窗編輯
        const itemInputRef = ref(null);
        const isItemInvalid = ref(false);
        const isPayerInvalid = ref(false);
        const isSplitInvalid = ref(false);
        // 全體結算預設收合：個人視角改版後，「我的總覽」才是記帳頁主要內容，全體結算退居「展開」才看得到的次要區塊
        const showOverallSettlement = ref(false);
        const addExpense = async () => {
            isItemInvalid.value = false; isAmountInvalid.value = false; isPayerInvalid.value = false; isSplitInvalid.value = false;
            if (!newExpense.value.paidByMemberId) newExpense.value.paidByMemberId = currentActorMemberId.value || (activeMembers.value[0]?.id ?? '');
            const err = validateExpenseDraft(newExpense.value);
            if (err) {
                console.error('Add expense validation failed:', err, JSON.parse(JSON.stringify(newExpense.value)));
                if (err === '請輸入支出名稱') { isItemInvalid.value = true; nextTick(() => { itemInputRef.value?.focus(); }); }
                else if (err === '請輸入有效金額') { isAmountInvalid.value = true; nextTick(() => { amountInputRef.value?.focus(); }); }
                else if (err === '請選擇付款者') { isPayerInvalid.value = true; }
                else if (err === '請至少選擇一位分攤對象') { isSplitInvalid.value = true; }
                showToast(err, { icon: 'ph-bold ph-warning' });
                return;
            }
            if (!db || !currentTripId.value) { showToast('尚未連線到資料庫，請稍後再試', { icon: 'ph-bold ph-warning' }); return; }
            const payerId = newExpense.value.paidByMemberId;
            const amount = Number(newExpense.value.amount) || 0;
            const nowIso = new Date().toISOString();
            const ref = doc(collection(db, 'trips', currentTripId.value, 'expenses'));
            const rateFields = buildExpenseRateFields(newExpense.value);
            const splitMethod = newExpense.value.splitMethod || 'equal';
            expenseSyncStatus.value = 'saving';
            try {
                await setDoc(ref, {
                    title: newExpense.value.title.trim(),
                    category: newExpense.value.category || 'other',
                    amount,
                    currency: newExpense.value.currency || setup.value.currency || 'USD',
                    ...rateFields,
                    summaryAmountTWD: amount * (Number(rateFields.exchangeRateToTWD) || 0),
                    paidByMemberId: payerId,
                    splitAmongMemberIds: splitMethod === 'personal' ? [payerId] : [...newExpense.value.splitAmongMemberIds],
                    splitMethod,
                    customSplits: (splitMethod === 'customAmount' || splitMethod === 'customPercent') ? { ...newExpense.value.customSplits } : {},
                    notes: newExpense.value.notes || '',
                    sourceBookingId: null,
                    createdAt: nowIso, createdByMemberId: currentActorMemberId.value,
                    updatedAt: nowIso, updatedByMemberId: currentActorMemberId.value,
                    version: 1,
                    deleted: false, deletedAt: null, deletedByMemberId: null,
                });
                expenseSyncStatus.value = 'synced';
            } catch (e) {
                console.error('Add expense failed', e);
                expenseSyncStatus.value = 'error';
                showToast(firebaseErrorMessage(e, '新增支出失敗'), { icon: 'ph-bold ph-warning' });
                return;
            }
            newExpense.value = createExpenseDraft();
            newExpense.value.paidByMemberId = payerId; // 沿用上一筆的付款人，方便同一人連續記好幾筆
            applyFetchedRate(newExpense.value); // 重置後的草稿匯率是 null，立刻補一次快照，下一筆才填得進去
        };

        // 編輯彈窗：draft 制 + optimistic concurrency——開窗時記下當時讀到的 version（baseVersion），
        // 存檔改用 transaction：先讀一次伺服器上「現在」的 version，跟 baseVersion 不一致就代表旅伴
        // 在我編輯的這段時間內已經存過一次，直接中止交易、回報衝突，不會用我這份（可能過時）的草稿蓋過去。
        const expModal = reactive({ show: false, targetId: null, draft: null, baseVersion: null, saveStatus: 'idle', conflictWith: null, errorMsg: '' });
        const openExpModal = (exp) => {
            expModal.targetId = exp.id;
            expModal.draft = JSON.parse(JSON.stringify(exp));
            // 舊資料（新增多幣別/分類/自訂分攤等欄位之前建立的支出）可能缺欄位，補上預設值，
            // 避免編輯彈窗的下拉選單顯示空白、或欄位是 undefined。刻意不在這裡呼叫 applyFetchedRate 重新抓匯率——
            // 這筆支出當初存的匯率是歷史快照，開編輯彈窗只是要看/改內容，不代表要重新核算匯率（需求 B 規則 2）。
            if (!expModal.draft.category) expModal.draft.category = 'other';
            if (!expModal.draft.currency) expModal.draft.currency = setup.value.currency || 'USD';
            // 需求 H：舊資料缺 exchangeRateToTWD 時，TWD 支出本來就是 1，其餘幣別絕對不能偷偷補 1——
            // 留白讓 expenseNeedsRate/UI 警告顯示出來，逼使用者自己補一個真的匯率再存檔。
            if (expModal.draft.exchangeRateToTWD == null) expModal.draft.exchangeRateToTWD = expModal.draft.currency === 'TWD' ? 1 : null;
            if (!expModal.draft.exchangeRateSource) expModal.draft.exchangeRateSource = expModal.draft.currency === 'TWD' ? 'same-currency' : 'manual';
            if (!expModal.draft.splitMethod) expModal.draft.splitMethod = 'equal';
            if (!expModal.draft.splitAmongMemberIds || !expModal.draft.splitAmongMemberIds.length) expModal.draft.splitAmongMemberIds = defaultSplitIds();
            if (!expModal.draft.customSplits) expModal.draft.customSplits = {};
            if (expModal.draft.notes == null) expModal.draft.notes = '';
            expModal.baseVersion = exp.version || 1;
            expModal.saveStatus = 'idle';
            expModal.conflictWith = null;
            expModal.errorMsg = '';
            expModal.show = true;
        };
        const saveExpModal = async (force = false) => {
            if (!db || !currentTripId.value || !expModal.targetId || !expModal.draft) { expModal.show = false; return; }
            const draft = expModal.draft;
            expModal.errorMsg = '';
            const err = validateExpenseDraft(draft);
            if (err) {
                console.error('Save expense validation failed:', err, JSON.parse(JSON.stringify(draft)));
                expModal.errorMsg = err;
                showToast(err, { icon: 'ph-bold ph-warning' });
                return;
            }
            const ref = doc(db, 'trips', currentTripId.value, 'expenses', expModal.targetId);
            const baseVersion = expModal.baseVersion;
            const actorId = currentActorMemberId.value;
            const amount = Number(draft.amount) || 0;
            const rateFields = buildExpenseRateFields(draft);
            const splitMethod = draft.splitMethod || 'equal';
            expModal.saveStatus = 'saving';
            try {
                await runTransaction(db, async (tx) => {
                    const snap = await tx.get(ref);
                    if (!snap.exists()) { const err = new Error('not-found'); throw err; }
                    const live = snap.data();
                    if (!force && (live.version || 1) !== baseVersion) {
                        const err = new Error('version-conflict');
                        err.live = live;
                        throw err;
                    }
                    tx.update(ref, {
                        title: draft.title.trim(),
                        category: draft.category || 'other',
                        amount,
                        currency: draft.currency || live.currency || setup.value.currency || 'USD',
                        ...rateFields,
                        summaryAmountTWD: amount * (Number(rateFields.exchangeRateToTWD) || 0),
                        paidByMemberId: draft.paidByMemberId,
                        splitAmongMemberIds: splitMethod === 'personal' ? [draft.paidByMemberId] : [...draft.splitAmongMemberIds],
                        splitMethod,
                        customSplits: (splitMethod === 'customAmount' || splitMethod === 'customPercent') ? { ...draft.customSplits } : {},
                        notes: draft.notes || '',
                        updatedAt: new Date().toISOString(),
                        updatedByMemberId: actorId,
                        version: (force ? (live.version || 1) : baseVersion) + 1,
                    });
                });
                expModal.saveStatus = 'synced';
                expModal.show = false;
            } catch (e) {
                if (e.message === 'version-conflict') {
                    expModal.saveStatus = 'conflict';
                    expModal.conflictWith = e.live;
                    showToast('這筆支出已被其他人更新，請選擇重新載入或覆蓋', { icon: 'ph-bold ph-warning', duration: 4000 });
                    return;
                }
                console.error('Save expense failed', e);
                expModal.saveStatus = 'error';
                expModal.errorMsg = firebaseErrorMessage(e, '儲存失敗');
                showToast(expModal.errorMsg, { icon: 'ph-bold ph-warning' });
            }
        };
        // 衝突發生時的兩個選擇：載入對方最新版本重填草稿，或者確認後強制蓋過去（force:true 略過 version 檢查）
        const reloadExpModalFromConflict = () => {
            if (!expModal.conflictWith) return;
            expModal.draft = { ...expModal.draft, ...expModal.conflictWith, id: expModal.targetId };
            expModal.baseVersion = expModal.conflictWith.version || 1;
            expModal.saveStatus = 'idle';
            expModal.conflictWith = null;
            showToast('已載入最新版本，請確認內容後再儲存');
        };
        const overwriteExpModalConflict = () => saveExpModal(true);
        const undoDeleteExpense = async (tripId, expenseId) => {
            if (!db || !tripId) return;
            const ref = doc(db, 'trips', tripId, 'expenses', expenseId);
            try {
                await runTransaction(db, async (tx) => {
                    const snap = await tx.get(ref);
                    if (!snap.exists()) return;
                    const live = snap.data();
                    tx.update(ref, { deleted: false, deletedAt: null, deletedByMemberId: null, updatedAt: new Date().toISOString(), updatedByMemberId: currentActorMemberId.value, version: (live.version || 1) + 1 });
                });
            } catch (e) { console.error('Undo delete expense failed', e); }
        };
        // 軟刪除：只標記 deleted/deletedAt/deletedByMemberId，不會真的砍掉文件——同步延遲或手滑誤刪都還救得回來
        const deleteExpFromModal = async () => {
            if (!db || !currentTripId.value || !expModal.targetId) { expModal.show = false; return; }
            const tripId = currentTripId.value;
            const expenseId = expModal.targetId;
            const ref = doc(db, 'trips', tripId, 'expenses', expenseId);
            expModal.show = false;
            try {
                await runTransaction(db, async (tx) => {
                    const snap = await tx.get(ref);
                    if (!snap.exists()) return;
                    const live = snap.data();
                    tx.update(ref, { deleted: true, deletedAt: new Date().toISOString(), deletedByMemberId: currentActorMemberId.value, updatedAt: new Date().toISOString(), updatedByMemberId: currentActorMemberId.value, version: (live.version || 1) + 1 });
                });
                showToast('已刪除支出', { icon: 'ph-bold ph-trash', undo: () => undoDeleteExpense(tripId, expenseId) });
            } catch (e) {
                console.error('Delete expense failed', e);
                showToast('刪除失敗，請檢查網路後再試', { icon: 'ph-bold ph-warning' });
            }
        };

        // ---- 訂位與票券總表（Bookings）：集中管理飯店/航班/餐廳訂位/票券，跟 itinerary/expenses 是各自獨立的資料，互不影響 ----
        // 每個 type 欄位形狀不同（hotel 有 check-in/out，flight 是 journey+多個 segments，其餘沿用通用欄位）；
        // 切換 type 時用 createBookingDraftForType 重建 draft，共用欄位（bookedBy/notes/confirmationNumber）會盡量保留。
        const BOOKING_TYPE_META = {
            hotel: { label: '飯店', icon: 'ph-bold ph-bed' },
            flight: { label: '航班', icon: 'ph-bold ph-airplane-tilt' },
            restaurant: { label: '餐廳訂位', icon: 'ph-bold ph-fork-knife' },
            ticket: { label: '票券', icon: 'ph-bold ph-ticket' },
            other: { label: '其他', icon: 'ph-bold ph-bookmark-simple' },
        };
        // Bookings 的航班段是獨立的形狀（分開的 date/time 欄位，confirmationNumber 在 journey 層級不在段落），
        // 跟 day.flight 的航班段（datetime-local 合併欄位）不同，故意分開兩份 factory，不要互相套用錯欄位
        const createBookingFlightSegment = () => ({
            id: generateId(), airline: '', flightNumber: '', departureAirport: '', arrivalAirport: '',
            departureDate: '', departureTime: '', arrivalDate: '', arrivalTime: '',
            departureTerminal: '', arrivalTerminal: '', segmentNotes: ''
        });
        // cost/currency/paidByMemberId/syncTo*：需求 B、C、D 共用的欄位，放在 common 讓所有 type（含 flight）都有，
        // 不用每個 type 各自重複宣告一次。exchangeRateToTWD 只在 currency 不是 TWD 時才需要填。
        // splitAmongMemberIds/splitMethod/customSplits：同步到記帳前，使用者必須在這裡補齊分攤方式（需求 E），
        // 否則這筆費用只是存在 booking 上的數字，不會真的進共同結算。
        const createBookingDraftForType = (type, base = {}) => {
            const common = {
                id: base.id || generateId(), type, bookedBy: base.bookedBy || '', notes: base.notes || '', confirmationNumber: base.confirmationNumber || '',
                cost: base.cost || '', currency: base.currency || setup.value.currency || 'USD',
                exchangeRateToTWD: base.exchangeRateToTWD || '',
                exchangeRateFetchedAt: base.exchangeRateFetchedAt || null,
                exchangeRateSource: base.exchangeRateSource || 'same-currency',
                paidByMemberId: base.paidByMemberId || '',
                splitAmongMemberIds: (base.splitAmongMemberIds && base.splitAmongMemberIds.length) ? base.splitAmongMemberIds : defaultSplitIds(),
                splitMethod: base.splitMethod || 'equal',
                customSplits: base.customSplits || {},
                syncToItinerary: !!base.syncToItinerary, syncToExpense: !!base.syncToExpense,
            };
            if (type === 'hotel') {
                return { ...common, hotelName: base.hotelName || '', checkInDate: base.checkInDate || '', checkOutDate: base.checkOutDate || '', location: base.location || '' };
            }
            if (type === 'flight') {
                return { ...common, journeyName: base.journeyName || '', segments: (base.segments && base.segments.length) ? base.segments : [createBookingFlightSegment()] };
            }
            // restaurant / ticket / other：沿用通用欄位
            return { ...common, title: base.title || '', date: base.date || '', time: base.time || '', location: base.location || '' };
        };
        // ---- 需求 B：Booking → Itinerary 同步 --------------------------------------------------------
        // 用 sourceBookingId（+ sourceItemKey 區分同一筆 booking 底下的多個項目，例如 hotel 的 check-in/check-out、
        // flight 的每個 segment）標記「這筆行程項目是哪個 booking 產生的」，不用另外在 booking 上存一份
        // generatedItineraryItemIds——每次儲存都用「先整批移除舊的、再依目前 draft 內容重新產生」的方式做，
        // 天生冪等（同一份 booking 存幾次結果都一樣），也天生不會重複：這是刻意的最小修改取捨，
        // 代價是使用者若手動改過同步產生的那筆行程項目，下次存 booking 會被覆蓋回去。
        const findItineraryDayIndexByDate = (fullDate) => days.value.findIndex(d => d.fullDate === fullDate);
        const removeGeneratedItineraryItems = (bookingId) => {
            days.value.forEach(day => {
                if (!day.items || !day.items.length) return;
                day.items = day.items.filter(i => i.sourceBookingId !== bookingId);
            });
        };
        // 依 booking type 決定要展開成哪些行程項目：hotel→check-in/check-out 兩筆、flight→每個 segment 一筆、
        // restaurant/ticket→各一筆。缺日期的項目（TBD）直接跳過，不會產生「掛不到任何一天」的孤兒項目。
        const buildDesiredItineraryItemsForBooking = (b) => {
            if (b.type === 'hotel') {
                const items = [];
                if (b.checkInDate) items.push({ key: 'checkin', date: b.checkInDate, time: '', type: 'hotel', activity: `Check-in：${b.hotelName || '飯店'}`, location: b.location || '', note: '確認碼已儲存在訂位頁' });
                if (b.checkOutDate) items.push({ key: 'checkout', date: b.checkOutDate, time: '', type: 'hotel', activity: `Check-out：${b.hotelName || '飯店'}`, location: b.location || '', note: '確認碼已儲存在訂位頁' });
                return items;
            }
            // flight 不走這裡：航班一律同步到「航班資訊」卡片（見 syncFlightBookingToFlightInfo），
            // 不會產生一般 itinerary item，否則會同時出現在 timeline 又出現在航班資訊，見需求文件。
            if (b.type === 'restaurant') {
                if (!b.date) return [];
                return [{ key: 'main', date: b.date, time: b.time || '', type: 'food', activity: b.title || '餐廳訂位', location: b.location || '', note: b.confirmationNumber ? '確認碼已儲存在訂位頁' : '' }];
            }
            if (b.type === 'ticket') {
                if (!b.date) return [];
                return [{ key: 'main', date: b.date, time: b.time || '', type: 'spot', activity: b.title || '票券活動', location: b.location || '', note: b.confirmationNumber ? '確認碼已儲存在訂位頁' : '' }];
            }
            return [];
        };
        // flight booking 勾選「同步到行程」時，不建立一般 itinerary item，改把航段投影到當天的
        // 「航班資訊」卡片（day.flight）——跟 day.flight 手動輸入是同一份資料/同一個 UI，只是來源是 booking。
        // 用 day.flight.sourceBookingId 標記「這張卡片是哪個 booking 產生的」，重存 booking 時整張覆蓋重建（冪等，
        // 跟 removeGeneratedItineraryItems 同一套取捨）；如果當天已經有「別的來源」的航班卡片（手動建立或另一筆
        // booking），為了不覆蓋使用者既有資料，直接跳過並提示，而不是硬蓋過去。
        const removeGeneratedFlightInfo = (bookingId) => {
            days.value.forEach(day => {
                if (day.flight && day.flight.sourceBookingId === bookingId) day.flight = null;
            });
        };
        const bookingSegmentToFlightCardSegment = (s, confirmationNumber) => ({
            id: generateId(), airline: s.airline || '', flightNumber: s.flightNumber || '',
            departureAirport: s.departureAirport || '', arrivalAirport: s.arrivalAirport || '',
            departureDateTime: (s.departureDate && s.departureTime) ? `${s.departureDate}T${s.departureTime}` : '',
            arrivalDateTime: (s.arrivalDate && s.arrivalTime) ? `${s.arrivalDate}T${s.arrivalTime}` : '',
            departureTerminal: s.departureTerminal || '', arrivalTerminal: s.arrivalTerminal || '',
            confirmationNumber: confirmationNumber || '', notes: s.segmentNotes || ''
        });
        const syncFlightBookingToFlightInfo = (b) => {
            removeGeneratedFlightInfo(b.id);
            if (!b.syncToItinerary) return { created: 0, skipped: 0 };
            const segments = (b.segments || []).filter(s => s.departureDate);
            if (!segments.length) return { created: 0, skipped: 0 };
            const dayIdx = findItineraryDayIndexByDate(segments[0].departureDate);
            if (dayIdx === -1) {
                showToast('航班日期不在旅程範圍內，未加入航班資訊', { icon: 'ph-bold ph-warning' });
                return { created: 0, skipped: 1 };
            }
            const day = days.value[dayIdx];
            if (day.flight && day.flight.sourceBookingId !== b.id) {
                showToast('當天已有航班資訊卡片，未覆蓋；請先手動移除再同步', { icon: 'ph-bold ph-warning' });
                return { created: 0, skipped: 1 };
            }
            day.flight = {
                id: generateId(), label: b.journeyName || '', sourceBookingId: b.id,
                segments: segments.map(s => bookingSegmentToFlightCardSegment(s, b.confirmationNumber))
            };
            return { created: 1, skipped: 0 };
        };
        const syncBookingToItinerary = (b) => {
            if (b.type === 'flight') return syncFlightBookingToFlightInfo(b);
            removeGeneratedItineraryItems(b.id);
            if (!b.syncToItinerary) return { created: 0, skipped: 0 };
            let created = 0, skipped = 0;
            buildDesiredItineraryItemsForBooking(b).forEach(d => {
                const dayIdx = findItineraryDayIndexByDate(d.date);
                if (dayIdx === -1) { skipped++; return; }
                days.value[dayIdx].items.push({
                    id: generateId(), time: d.time || '', type: d.type, activity: d.activity,
                    location: d.location || '', link: '', note: d.note || '',
                    sourceBookingId: b.id, sourceItemKey: d.key
                });
                sortItemsByTime(days.value[dayIdx].items);
                created++;
            });
            if (skipped) showToast(`${skipped} 筆日期不在旅程範圍內，未加入行程`, { icon: 'ph-bold ph-warning' });
            return { created, skipped };
        };

        // ---- 需求 C：Booking → Expense 同步 ----------------------------------------------------------
        // 用 expense.sourceBookingId 反查「這個 booking 是否已經有對應的 expense」，避免重複新增；
        // booking cost/currency 改了、且已經有連過的 expense 時，用 appConfirm 問過使用者才更新，不安靜蓋過去。
        const findExpenseByBookingId = (bookingId) => activeExpenses.value.find(e => e.sourceBookingId === bookingId);
        const defaultExpenseTitleForBooking = (b) => {
            if (b.type === 'hotel') return `Hotel - ${b.hotelName || '未命名飯店'}`;
            if (b.type === 'flight') return `Flight - ${b.journeyName || '未命名航程'}`;
            if (b.type === 'restaurant') return `Restaurant - ${b.title || '未命名餐廳'}`;
            if (b.type === 'ticket') return `Ticket - ${b.title || '未命名票券'}`;
            return b.title || '訂位費用';
        };
        // booking type → expense category 的對應：讓同步過去的支出一樣能照分類看報表，不會全部落在「其他」
        const bookingCategoryForType = (type) => ({ hotel: 'lodging', flight: 'transport', restaurant: 'food', ticket: 'ticket' }[type] || 'other');
        const syncBookingToExpense = async (b) => {
            if (!db || !currentTripId.value) return;
            const existing = findExpenseByBookingId(b.id);
            const cost = Number(b.cost);
            if (!b.syncToExpense || !cost) {
                // 使用者取消同步，或把費用清空了：如果之前同步過，軟刪除那筆自動建立的 expense，避免留下孤兒支出
                if (existing) {
                    try {
                        const ref = doc(db, 'trips', currentTripId.value, 'expenses', existing.id);
                        await setDoc(ref, { deleted: true, deletedAt: new Date().toISOString(), deletedByMemberId: currentActorMemberId.value, updatedAt: new Date().toISOString(), version: (existing.version || 1) + 1 }, { merge: true });
                    } catch (e) {
                        console.error('Remove synced expense failed', e);
                        showToast(firebaseErrorMessage(e, '移除記帳同步失敗'), { icon: 'ph-bold ph-warning' });
                    }
                }
                return;
            }
            const title = defaultExpenseTitleForBooking(b);
            // 同步前必須先補齊付款者/分攤對象/分攤方式/幣別/匯率（需求 E），不能只把 cost 存起來卻不進結算——
            // 沿用跟一般支出表單完全相同的驗證，缺什麼就用完全相同的措辭告訴使用者缺什麼。
            const draftForValidation = {
                title, amount: cost, currency: b.currency || setup.value.currency || 'USD',
                paidByMemberId: b.paidByMemberId, splitAmongMemberIds: b.splitAmongMemberIds || [],
                splitMethod: b.splitMethod || 'equal', customSplits: b.customSplits || {},
                exchangeRateToTWD: b.exchangeRateToTWD,
            };
            const err = validateExpenseDraft(draftForValidation);
            if (err) {
                console.error('Sync booking to expense validation failed:', err, JSON.parse(JSON.stringify(b)));
                showToast(`訂位費用尚未同步到記帳：${err}`, { icon: 'ph-bold ph-warning' });
                return;
            }
            const rateFields = buildExpenseRateFields(draftForValidation);
            const payerId = b.paidByMemberId;
            const nowIso = new Date().toISOString();
            const splitMethod = draftForValidation.splitMethod;
            const payload = {
                title, category: bookingCategoryForType(b.type), amount: cost,
                currency: draftForValidation.currency,
                ...rateFields, summaryAmountTWD: cost * (Number(rateFields.exchangeRateToTWD) || 0),
                paidByMemberId: payerId,
                splitAmongMemberIds: splitMethod === 'personal' ? [payerId] : [...(b.splitAmongMemberIds || [])],
                splitMethod,
                customSplits: (splitMethod === 'customAmount' || splitMethod === 'customPercent') ? { ...(b.customSplits || {}) } : {},
                notes: b.notes || '',
                sourceBookingId: b.id,
                updatedAt: nowIso, updatedByMemberId: currentActorMemberId.value,
            };
            try {
                if (existing) {
                    const costChanged = Number(existing.amount) !== cost || existing.currency !== payload.currency;
                    if (costChanged) {
                        const ok = await appConfirm(`這個訂位的費用已變更為 ${payload.currency} ${cost}，要更新記帳裡對應的支出嗎？`, { title: '更新支出', confirmText: '更新' });
                        if (!ok) return;
                    }
                    const ref = doc(db, 'trips', currentTripId.value, 'expenses', existing.id);
                    await setDoc(ref, { ...payload, version: (existing.version || 1) + 1 }, { merge: true });
                } else {
                    const ref = doc(collection(db, 'trips', currentTripId.value, 'expenses'));
                    await setDoc(ref, {
                        ...payload,
                        createdAt: nowIso, createdByMemberId: currentActorMemberId.value,
                        version: 1, deleted: false, deletedAt: null, deletedByMemberId: null,
                    });
                }
            } catch (e) {
                console.error('Sync booking to expense failed', e);
                showToast(firebaseErrorMessage(e, '同步到記帳失敗'), { icon: 'ph-bold ph-warning' });
            }
        };

        const bookingModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openBookingModal = (b = null) => {
            if (b) {
                bookingModal.mode = 'edit'; bookingModal.targetId = b.id;
                bookingModal.draft = createBookingDraftForType(b.type || 'other', JSON.parse(JSON.stringify(b)));
            } else {
                bookingModal.mode = 'add'; bookingModal.targetId = null;
                bookingModal.draft = createBookingDraftForType('hotel', { bookedBy: activeChecklistMember.value || '' });
            }
            bookingModal.show = true;
            if (!b) nextTick(() => { document.querySelector('.js-booking-title, .js-booking-journey-name')?.focus(); });
        };
        // 切換分類（飯店/航班/...）：換一副對應形狀的 draft，避免把 BR8 這種航班號存進飯店名稱欄位
        const switchBookingDraftType = (type) => {
            if (!bookingModal.draft || bookingModal.draft.type === type) return;
            bookingModal.draft = createBookingDraftForType(type, bookingModal.draft);
        };
        const saveBookingModal = async () => {
            let saved = null;
            if (bookingModal.mode === 'edit') {
                const target = bookings.value.find(b => b.id === bookingModal.targetId);
                if (target) { Object.assign(target, bookingModal.draft); saved = target; }
            } else {
                saved = { ...bookingModal.draft };
                bookings.value.push(saved);
            }
            bookingModal.show = false;
            if (!saved) return;
            syncBookingToItinerary(saved);
            await syncBookingToExpense(saved);
        };
        const deleteBookingFromModal = async () => {
            bookingModal.show = false;
            const idx = bookings.value.findIndex(b => b.id === bookingModal.targetId);
            if (idx === -1) return;
            const removed = bookings.value.splice(idx, 1)[0];
            // 連動清掉這筆 booking 產生的行程項目和記帳項目，避免刪除訂位後留下孤兒資料；
            // 註：這兩個連動清除目前不隨 undo 復原（只有 booking 本身會復原），是刻意的最小修改取捨
            removeGeneratedItineraryItems(removed.id);
            removeGeneratedFlightInfo(removed.id);
            const linkedExpense = findExpenseByBookingId(removed.id);
            if (linkedExpense && db && currentTripId.value) {
                const ref = doc(db, 'trips', currentTripId.value, 'expenses', linkedExpense.id);
                setDoc(ref, { deleted: true, deletedAt: new Date().toISOString(), deletedByMemberId: currentActorMemberId.value, updatedAt: new Date().toISOString(), version: (linkedExpense.version || 1) + 1 }, { merge: true }).catch(e => console.error('Delete linked expense failed', e));
            }
            showToast('已刪除訂位/票券', { icon: 'ph-bold ph-trash', undo: () => { bookings.value.splice(Math.min(idx, bookings.value.length), 0, removed); } });
        };
        // 依 type 決定拿哪個欄位當排序用的日期：hotel 用 check-in、flight 用第一段的出發日期時間、其餘沿用通用 date/time
        const bookingSortKey = (b) => {
            if (b.type === 'hotel') return `${b.checkInDate || ''}`;
            if (b.type === 'flight') { const s = b.segments?.[0]; return s ? `${s.departureDate || ''}${s.departureTime || ''}` : ''; }
            return `${b.date || ''}${b.time || ''}`;
        };
        const sortedBookings = computed(() => [...bookings.value].sort((a, b) => bookingSortKey(a).localeCompare(bookingSortKey(b))));
        // 確認碼/票券號碼預設遮蔽，跟航班段共用同一套遮蔽 UI 邏輯，但分開存避免 id 混淆
        const revealedBookingConfirmations = reactive({});
        const toggleBookingConfirmation = (bookingId) => { revealedBookingConfirmations[bookingId] = !revealedBookingConfirmations[bookingId]; };
        // Bookings 航班段的日期時間是分開欄位（不是 datetime-local），組成字串後沿用既有的 formatLayover 算轉機時間
        const formatBookingSegDateTime = (date, time) => date ? `${date.replaceAll('-', '/')}${time ? ' ' + time : ''}` : (time || '');
        const bookingLayover = (prevSeg, nextSeg) => {
            const arr = (prevSeg.arrivalDate && prevSeg.arrivalTime) ? `${prevSeg.arrivalDate}T${prevSeg.arrivalTime}` : '';
            const dep = (nextSeg.departureDate && nextSeg.departureTime) ? `${nextSeg.departureDate}T${nextSeg.departureTime}` : '';
            return layoverLabel(arr, dep);
        };

        // ============================================================================================
        // ASA 議程模組（Conference / Sessions / Venue Index / My Presentation）
        // 目前 ASA 2026 完整議程還沒公開，這裡刻意不預先塞任何真的 session 資料——整個模組設計成
        // 「可匯入、可搜尋、可標記、可加入行程」的空殼，等官方議程公布後由使用者自己貼 JSON/CSV 進來，
        // 或手動一筆一筆新增。不會、也不應該去爬 ASA 官網或任何需要登入/有存取限制的頁面。
        // ============================================================================================
        const conferenceSubView = ref('sessions'); // 'sessions' | 'venues' | 'presentation'
        const conferenceSessions = ref([]);
        const conferenceVenues = ref([]);
        const defaultPresentation = () => ({ title: '', date: '', time: '', location: '', posterNumber: '', uploadDeadline: '', checkInRequirement: '', notes: '' });
        const myPresentation = ref(defaultPresentation());

        const SESSION_TYPES = [
            { value: 'lecture', label: 'Lecture' }, { value: 'workshop', label: 'Workshop' },
            { value: 'poster', label: 'Poster' }, { value: 'panel', label: 'Panel' },
            { value: 'pbld', label: 'PBLD' }, { value: 'exhibit', label: 'Exhibit' }, { value: 'other', label: '其他' },
        ];
        const TOPIC_CATEGORIES = [
            { value: 'airway', label: 'Airway' }, { value: 'difficult_airway', label: 'Difficult airway' },
            { value: 'thoracic', label: 'Thoracic anesthesia' }, { value: 'olv', label: 'One-lung ventilation' },
            { value: 'dlt', label: 'Double-lumen tube / bronchial blocker' }, { value: 'cardiac', label: 'Cardiac anesthesia' },
            { value: 'tee', label: 'TEE' }, { value: 'regional', label: 'Regional anesthesia' },
            { value: 'pain', label: 'Pain medicine' }, { value: 'research', label: 'Research / abstract / poster' },
            { value: 'ai', label: 'AI in anesthesia' }, { value: 'qi', label: 'Quality improvement' },
            { value: 'critical_care', label: 'Critical care' }, { value: 'other', label: 'Other' },
        ];
        const SESSION_PRIORITY_META = {
            must: { label: 'Must attend', cls: 'bg-red-50 text-red-600 border-red-100' },
            interested: { label: 'Interested', cls: 'bg-primary-50 text-primary-600 border-primary-100' },
            backup: { label: 'Backup', cls: 'bg-stone-100 text-stone-500 border-stone-200' },
        };
        const sessionTypeLabel = (v) => SESSION_TYPES.find(t => t.value === v)?.label || v || '';
        const topicCategoryLabel = (v) => TOPIC_CATEGORIES.find(t => t.value === v)?.label || v || '';

        // 關鍵字自動推薦（只是「候選」提示，不會自動幫使用者設定 priority）；短縮寫用 word boundary 比對，
        // 避免誤中一般英文字（例如 committee 裡有 tee、training 裡有 ai）
        const RECOMMEND_PHRASES = ['difficult airway', 'airway', 'thoracic', 'one-lung ventilation', 'double-lumen tube', 'bronchial blocker', 'cardiac anesthesia', 'transesophageal echocardiography', 'regional anesthesia', 'pain', 'quality improvement', 'artificial intelligence', 'research', 'poster'];
        const RECOMMEND_ACRONYMS = ['olv', 'dlt', 'tee', 'ai', 'qi'];
        const isRecommendedCandidate = (session) => {
            const text = `${session.title || ''} ${session.description || ''}`.toLowerCase();
            if (RECOMMEND_PHRASES.some(k => text.includes(k))) return true;
            return RECOMMEND_ACRONYMS.some(a => new RegExp(`\\b${a}\\b`, 'i').test(text));
        };

        // ---- 搜尋 / 分類篩選 ----
        const sessionSearchQuery = ref('');
        const sessionCategoryFilter = ref('');
        const filteredSessions = computed(() => {
            const q = sessionSearchQuery.value.trim().toLowerCase();
            return conferenceSessions.value
                .filter(s => !sessionCategoryFilter.value || s.topicCategory === sessionCategoryFilter.value)
                .filter(s => !q || [s.title, s.speakers, s.room, s.location, s.sessionId].some(f => (f || '').toLowerCase().includes(q)))
                .sort((a, b) => `${a.date || ''}${a.startTime || ''}`.localeCompare(`${b.date || ''}${b.startTime || ''}`));
        });

        // ---- My ASA Schedule：加入/移出每日 itinerary，並偵測時間重疊 ----
        const isSessionInItinerary = (session) => {
            if (session.itineraryDayIdx == null || !session.itineraryItemId) return false;
            const day = days.value[session.itineraryDayIdx];
            return !!(day && day.items.some(i => i.id === session.itineraryItemId));
        };
        const addSessionToItinerary = (session) => {
            if (!session.date) { showToast('請先填寫這個 session 的日期才能加入行程', { icon: 'ph-bold ph-warning' }); return; }
            const dayIdx = days.value.findIndex(d => d.fullDate === session.date);
            if (dayIdx === -1) { showToast('這個日期不在目前旅程範圍內', { icon: 'ph-bold ph-warning' }); return; }
            const item = {
                id: generateId(), time: session.startTime || '', type: 'conference',
                activity: session.title || '未命名 Session',
                location: session.room || session.location || '',
                link: session.sourceUrl || '', note: session.notes || ''
            };
            days.value[dayIdx].items.push(item);
            sortItemsByTime(days.value[dayIdx].items);
            session.itineraryDayIdx = dayIdx;
            session.itineraryItemId = item.id;
            showToast('已加入我的 ASA 行程', { icon: 'ph-bold ph-calendar-check' });
        };
        const removeSessionFromItinerary = (session) => {
            if (session.itineraryDayIdx == null || !session.itineraryItemId) return;
            const day = days.value[session.itineraryDayIdx];
            if (day) {
                const idx = day.items.findIndex(i => i.id === session.itineraryItemId);
                if (idx !== -1) day.items.splice(idx, 1);
            }
            session.itineraryDayIdx = null; session.itineraryItemId = null;
            showToast('已從行程移除（session 本身還在議程列表中）', { icon: 'ph-bold ph-calendar-x' });
        };
        const timesOverlap = (aStart, aEnd, bStart, bEnd) => {
            if (!aStart || !bStart) return false;
            const aE = aEnd || aStart, bE = bEnd || bStart;
            return aStart < bE && bStart < aE;
        };
        // 只比對「已加入我的行程」的 session；沒加入的 session 之間時間重疊不算數（那只是議程本身本來就會並行的場次）
        const conflictingSessionIds = computed(() => {
            const scheduled = conferenceSessions.value.filter(isSessionInItinerary);
            const ids = new Set();
            for (let i = 0; i < scheduled.length; i++) {
                for (let j = i + 1; j < scheduled.length; j++) {
                    const a = scheduled[i], b = scheduled[j];
                    if (a.date && a.date === b.date && timesOverlap(a.startTime, a.endTime, b.startTime, b.endTime)) {
                        ids.add(a.id); ids.add(b.id);
                    }
                }
            }
            return ids;
        });

        // ---- Session 新增/編輯（跟其他模組同一套 draft 彈窗慣例）----
        const sessionModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const createEmptySession = () => ({
            id: generateId(), sessionId: '', title: '', date: '', startTime: '', endTime: '',
            location: '', room: '', sessionType: '', topicCategory: '', speakers: '', description: '', sourceUrl: '',
            priority: '', status: 'planned', notes: '', itineraryDayIdx: null, itineraryItemId: null,
        });
        const openSessionModal = (s = null) => {
            if (s) { sessionModal.mode = 'edit'; sessionModal.targetId = s.id; sessionModal.draft = JSON.parse(JSON.stringify(s)); }
            else { sessionModal.mode = 'add'; sessionModal.targetId = null; sessionModal.draft = createEmptySession(); }
            sessionModal.show = true;
            if (!s) nextTick(() => { document.querySelector('.js-session-title')?.focus(); });
        };
        const saveSessionModal = () => {
            if (sessionModal.mode === 'edit') {
                const target = conferenceSessions.value.find(s => s.id === sessionModal.targetId);
                if (target) Object.assign(target, sessionModal.draft);
                // 若已加入行程，date/startTime/title 改了要同步回去，itinerary 卡片才不會跟議程資料脫節
                if (target && isSessionInItinerary(target)) {
                    const day = days.value[target.itineraryDayIdx];
                    const item = day?.items.find(i => i.id === target.itineraryItemId);
                    if (item) {
                        item.time = target.startTime || ''; item.activity = target.title || '未命名 Session';
                        item.location = target.room || target.location || ''; item.link = target.sourceUrl || '';
                        sortItemsByTime(day.items);
                    }
                }
            } else {
                conferenceSessions.value.push({ ...sessionModal.draft });
            }
            sessionModal.show = false;
        };
        const deleteSessionFromModal = () => {
            sessionModal.show = false;
            const idx = conferenceSessions.value.findIndex(s => s.id === sessionModal.targetId);
            if (idx === -1) return;
            const target = conferenceSessions.value[idx];
            if (isSessionInItinerary(target)) removeSessionFromItinerary(target);
            const removed = conferenceSessions.value.splice(idx, 1)[0];
            showToast('已刪除議程', { icon: 'ph-bold ph-trash', undo: () => { conferenceSessions.value.splice(Math.min(idx, conferenceSessions.value.length), 0, removed); } });
        };

        // ---- 匯入：手動新增以外，支援貼上 JSON 或 CSV；不做任何自動抓取 ----
        const importSessionText = ref('');
        const importSessionFormat = ref('json'); // 'json' | 'csv'
        const normalizeImportedSession = (raw) => ({
            id: generateId(), sessionId: raw.sessionId || '', title: raw.title || '',
            date: raw.date || '', startTime: raw.startTime || '', endTime: raw.endTime || '',
            location: raw.location || '', room: raw.room || '', sessionType: raw.sessionType || '',
            topicCategory: raw.topicCategory || '', speakers: raw.speakers || '', description: raw.description || '',
            sourceUrl: raw.sourceUrl || '', priority: '', status: 'planned', notes: '',
            itineraryDayIdx: null, itineraryItemId: null,
        });
        const parseCsvLine = (line) => {
            const result = []; let cur = ''; let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (inQuotes) {
                    if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
                    else cur += c;
                } else {
                    if (c === '"') inQuotes = true;
                    else if (c === ',') { result.push(cur); cur = ''; }
                    else cur += c;
                }
            }
            result.push(cur);
            return result;
        };
        const parseCsvSessions = (text) => {
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 2) return [];
            const headers = parseCsvLine(lines[0]).map(h => h.trim());
            return lines.slice(1).map(line => {
                const cols = parseCsvLine(line);
                const obj = {};
                headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
                return obj;
            });
        };
        const importSessions = () => {
            const text = importSessionText.value.trim();
            if (!text) { showToast('請先貼上要匯入的內容', { icon: 'ph-bold ph-warning' }); return; }
            let rows = [];
            try {
                if (importSessionFormat.value === 'json') {
                    const parsed = JSON.parse(text);
                    rows = Array.isArray(parsed) ? parsed : [parsed];
                } else {
                    rows = parseCsvSessions(text);
                }
            } catch (e) {
                showToast('JSON 格式錯誤，請檢查後再試一次', { icon: 'ph-bold ph-warning' });
                return;
            }
            if (!rows.length) { showToast('沒有可匯入的資料', { icon: 'ph-bold ph-warning' }); return; }
            conferenceSessions.value.push(...rows.map(normalizeImportedSession));
            importSessionText.value = '';
            showToast(`已匯入 ${rows.length} 筆議程`, { icon: 'ph-bold ph-upload-simple' });
        };

        // ---- Venue / Room Index：跟口袋名單同一套簡單 CRUD 慣例 ----
        const venueModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openVenueModal = (v = null) => {
            if (v) { venueModal.mode = 'edit'; venueModal.targetId = v.id; venueModal.draft = JSON.parse(JSON.stringify(v)); }
            else { venueModal.mode = 'add'; venueModal.targetId = null; venueModal.draft = { id: generateId(), roomName: '', level: '', area: '', mapLink: '', notes: '' }; }
            venueModal.show = true;
            if (!v) nextTick(() => { document.querySelector('.js-venue-name')?.focus(); });
        };
        const saveVenueModal = () => {
            if (venueModal.mode === 'edit') {
                const target = conferenceVenues.value.find(v => v.id === venueModal.targetId);
                if (target) Object.assign(target, venueModal.draft);
            } else {
                conferenceVenues.value.push({ ...venueModal.draft });
            }
            venueModal.show = false;
        };
        const deleteVenueFromModal = () => {
            venueModal.show = false;
            const idx = conferenceVenues.value.findIndex(v => v.id === venueModal.targetId);
            if (idx === -1) return;
            const removed = conferenceVenues.value.splice(idx, 1)[0];
            showToast('已刪除場地', { icon: 'ph-bold ph-trash', undo: () => { conferenceVenues.value.splice(Math.min(idx, conferenceVenues.value.length), 0, removed); } });
        };

        const updateExchangeRate = () => { if (setup.value) setup.value.rate = exchangeRate.value; };

        const getExternalMapLink = (loc) => { if (!loc) return '#'; if (isUrl(loc)) return loc; const encodedLoc = encodeURIComponent(loc); if (setup.value.mapProvider === 'naver') return `https://map.naver.com/v5/search/${encodedLoc}`; else if (setup.value.mapProvider === 'amap') return `https://www.amap.com/search?query=${encodedLoc}`; else return `https://www.google.com/maps/search/?api=1&query=${encodedLoc}`; };
        // ---- 本日地圖：把當天每個行程項目貼的地點/Google 地圖連結，串成一條路線內嵌顯示 -------------------
        // 不申請 Google Maps API 金鑰，用舊版 maps.google.com 的 saddr/daddr（多站用 +to: 串接）+ output=embed
        // 網址技巧內嵌，這是 Google 官方 Embed API 之外行之有年、不需要金鑰的作法（沒有官方保證，理論上
        // Google 未來改版可能讓這個嵌入失效，但目前廣泛可用；一旦失效不影響「開啟連結」等其他既有地圖功能）。
        // 純地名/地址文字直接拿去查；如果貼的是完整 Google 地圖網址，嘗試從網址常見的
        // /maps/place/名稱、@緯度,經度、?q=關鍵字 三種格式抓出可讀的地點；縮網址（maps.app.goo.gl）
        // 前端沒辦法解析，直接跳過這筆，不會讓整條路線網址壞掉、也不會讓其他地點跟著顯示不出來。
        const extractMapWaypoint = (raw) => {
            if (!raw) return null;
            const val = String(raw).trim();
            if (!val) return null;
            if (!isUrl(val)) return val;
            let m = val.match(/\/maps\/place\/([^/@]+)/);
            if (m) { try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1].replace(/\+/g, ' '); } }
            m = val.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
            if (m) return `${m[1]},${m[2]}`;
            m = val.match(/[?&]q=([^&]+)/);
            if (m) { try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1].replace(/\+/g, ' '); } }
            return null;
        };
        // 縮網址（例如 Google 地圖 App「分享」按鈕產生的 maps.app.goo.gl/xxxx）沒辦法在前端解析：瀏覽器
        // 看不到跨網域 redirect 的目的地網址（CORS 限制讀不到 Location header），試過的免費展開服務
        // （allorigins.win）本身不穩定常常打不通，另一個 unshorten.me 雖然能用但匿名額度很低，兩個都不
        // 適合正式依賴，所以這裡不接任何第三方服務——縮網址一律當「沒辦法自動標在地圖上」處理，跳過但不報錯，
        // 並在下面 currentDayMapHasShortLinks 標記出來，UI 端會提示使用者改貼展開後的完整網址。
        const GOOGLE_SHORT_MAP_LINK_RE = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i;
        const currentDayMapWaypoints = computed(() => {
            try {
                return currentDayTimelineItems.value
                    .map(item => item && extractMapWaypoint(item.link || item.location))
                    .filter(Boolean);
            } catch (err) {
                console.error('currentDayMapWaypoints failed', err);
                return [];
            }
        });
        const currentDayMapHasShortLinks = computed(() => {
            return currentDayTimelineItems.value.some(item => {
                const raw = item && (item.link || item.location);
                return raw && GOOGLE_SHORT_MAP_LINK_RE.test(String(raw).trim()) && !extractMapWaypoint(raw);
            });
        });
        const currentDayMapEmbedUrl = computed(() => {
            const points = currentDayMapWaypoints.value;
            if (!points.length) return null;
            if (points.length === 1) return `https://maps.google.com/maps?q=${encodeURIComponent(points[0])}&output=embed`;
            const [first, ...rest] = points;
            const daddr = rest.map(p => encodeURIComponent(p)).join('+to:');
            return `https://maps.google.com/maps?saddr=${encodeURIComponent(first)}&daddr=${daddr}&output=embed`;
        });
        const currentDayMapSkippedCount = computed(() => {
            const withLink = currentDayTimelineItems.value.filter(item => item && (item.link || item.location)).length;
            return Math.max(0, withLink - currentDayMapWaypoints.value.length);
        });
        // ---- 口袋名單地圖：把整份口袋名單的地點串成一條路線內嵌顯示，方便一次比較所有候選景點彼此的
        // 地理位置，決定「這幾個離很近，可以排同一天」——跟本日地圖同一套 extractMapWaypoint／output=embed
        // 技巧。沒有貼連結時退回用地點名稱本身當查詢文字（跟 getExternalMapLink 對純文字地名的處理一樣）。
        // Google 這種舊版多站路線站數一多會不穩定，這裡上限只取前 10 個，超過的部分不畫進這張總覽地圖，
        // 想確認個別地點就直接點卡片上自己的「開啟連結」。
        const POCKET_MAP_MAX_WAYPOINTS = 10;
        const pocketListMapWaypoints = computed(() => {
            try {
                return (savedLocations.value || [])
                    .map(loc => loc && extractMapWaypoint(loc.link || loc.name))
                    .filter(Boolean)
                    .slice(0, POCKET_MAP_MAX_WAYPOINTS);
            } catch (err) {
                console.error('pocketListMapWaypoints failed', err);
                return [];
            }
        });
        const pocketListMapEmbedUrl = computed(() => {
            const points = pocketListMapWaypoints.value;
            if (!points.length) return null;
            if (points.length === 1) return `https://maps.google.com/maps?q=${encodeURIComponent(points[0])}&output=embed`;
            const [first, ...rest] = points;
            const daddr = rest.map(p => encodeURIComponent(p)).join('+to:');
            return `https://maps.google.com/maps?saddr=${encodeURIComponent(first)}&daddr=${daddr}&output=embed`;
        });
        const pocketListMapHasShortLinks = computed(() => {
            return (savedLocations.value || []).some(loc => {
                const raw = loc && (loc.link || loc.name);
                return raw && GOOGLE_SHORT_MAP_LINK_RE.test(String(raw).trim()) && !extractMapWaypoint(raw);
            });
        });
        // 有地點文字但沒畫進地圖的數量：解析失敗、或超過站數上限，都算在這裡，不特別區分原因
        const pocketListMapOmittedCount = computed(() => {
            const withAny = (savedLocations.value || []).filter(loc => loc && (loc.link || loc.name)).length;
            return Math.max(0, withAny - pocketListMapWaypoints.value.length);
        });
        const countryInfoMap = { 'jp': { c: 'JPY', l: 'ja', n: '日文', m: 'google' }, 'kr': { c: 'KRW', l: 'ko', n: '韓文', m: 'naver' }, 'us': { c: 'USD', l: 'en', n: '英文', m: 'google' }, 'cn': { c: 'CNY', l: 'zh-CN', n: '簡中', m: 'amap' }, 'th': { c: 'THB', l: 'th', n: '泰文', m: 'google' }, 'tw': { c: 'TWD', l: 'zh-TW', n: '中文', m: 'google' } };
        const updateRateByCurrency = async () => { const currency = setup.value.currency; if (!currency) return; isRateLoading.value = true; try { if (currency === 'TWD') { setup.value.rate = 1; } else { const rRes = await fetch(`https://api.exchangerate-api.com/v4/latest/${currency}`); const rData = await rRes.json(); if (rData?.rates?.TWD) setup.value.rate = rData.rates.TWD; } } catch (e) { console.error('Fetch rate failed', e); } finally { isRateLoading.value = false; } };
        const detectRate = async () => { if (!setup.value.destination) return; isRateLoading.value = true; try { const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(setup.value.destination)}&limit=1&addressdetails=1`); const geoData = await geoRes.json(); if (geoData?.[0]?.address?.country_code) { const code = geoData[0].address.country_code.toLowerCase(); const info = countryInfoMap[code] || { c: 'USD', l: 'en', n: '英文', m: 'google' }; setup.value.currency = info.c; setup.value.langCode = info.l; setup.value.langName = info.n; setup.value.mapProvider = info.m || 'google'; if (!weather.value.location) weather.value.location = setup.value.destination; if (info.c === 'TWD') setup.value.rate = 1; else { const rRes = await fetch(`https://api.exchangerate-api.com/v4/latest/${info.c}`); const rData = await rRes.json(); if (rData?.rates?.TWD) setup.value.rate = rData.rates.TWD; } } } catch (e) { } finally { isRateLoading.value = false; } };
        const toggleWeatherEdit = () => { isWeatherEditing.value = !isWeatherEditing.value; if (isWeatherEditing.value) { nextTick(() => weatherInputRef.value?.focus()); } };
        const updateWeatherLocation = () => { isWeatherEditing.value = false; if (weather.value.location) { fetchWeather(weather.value.location); } };
        const fetchWeather = async (locName) => { try { weather.value.location = locName; const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locName)}&limit=1`); const geoData = await geoRes.json(); if (geoData?.[0]) { const { lat, lon } = geoData[0]; const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`); const wData = await wRes.json(); weather.value.temp = Math.round(wData.current_weather.temperature); weather.value.icon = getWeatherIcon(wData.current_weather.weathercode); if (wData.daily) weather.value.daily = wData.daily; } } catch (e) { weather.value.temp = '--'; } };
        // 主內容包在 <transition mode="out-in">，切到口袋分頁時容器要等舊視圖淡出後才進 DOM，
        // 所以不能只在 nextTick 找一次——輪詢等到元素出現再掛，且防重複掛載
        const initSortable = () => { const el = document.getElementById('saved-locations-list'); if (!el) return false; if (Sortable.get && Sortable.get(el)) return true; Sortable.create(el, { animation: 150, handle: '.loc-drag-handle', ghostClass: 'sortable-ghost', dragClass: 'sortable-drag', onEnd: (evt) => { const item = savedLocations.value.splice(evt.oldIndex, 1)[0]; savedLocations.value.splice(evt.newIndex, 0, item); } }); return true; };
        const initSortableWhenReady = () => { let tries = 0; const tryInit = () => { if (!initSortable() && ++tries < 30) setTimeout(tryInit, 100); }; nextTick(tryInit); };

        const loadTripList = () => {
            const list = localStorage.getItem('travel_app_index');
            tripList.value = list ? JSON.parse(list) : [];
        };

        const saveTripList = async () => {
            localStorage.setItem('travel_app_index', JSON.stringify(tripList.value));
        };

        // ---- 所有旅程（伺服器全量清單；抽屜首開時一次撈取，session 內快取）----
        const allTrips = ref([]);
        const allTripsStatus = ref('idle'); // idle | loading | error | ready
        const showArchivedTrips = ref(false);
        const loadAllTrips = async () => {
            if (!db) return;
            allTripsStatus.value = 'loading';
            try {
                const snap = await getDocs(collection(db, 'trips'));
                allTrips.value = snap.docs.map(d => {
                    const data = d.data();
                    const s = data.setup || {};
                    return {
                        id: d.id,
                        destination: s.destination || '',
                        startDate: s.startDate || '',
                        daysCount: Number(s.days) || (data.days ? data.days.length : 0),
                        users: data.users || '',
                        archived: !!data.archived
                    };
                }).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
                allTripsStatus.value = 'ready';
            } catch (e) {
                console.error('Load all trips failed', e);
                allTripsStatus.value = 'error';
            }
        };
        const otherTrips = computed(() => allTrips.value.filter(t => !t.archived && !tripList.value.some(m => m.id === t.id)));
        const archivedTrips = computed(() => allTrips.value.filter(t => t.archived));
        // 點卡片＝加入我的旅程並開啟
        const adoptTrip = (t) => {
            if (!tripList.value.some(m => m.id === t.id)) {
                tripList.value.unshift({ id: t.id, destination: t.destination, startDate: t.startDate, daysCount: t.daysCount });
                saveTripList();
            }
            switchTrip(t.id);
        };
        const unarchiveTrip = async (t) => {
            if (db) {
                try {
                    await setDoc(doc(db, 'trips', t.id), { archived: false }, { merge: true });
                } catch (e) {
                    console.error('Unarchive failed', e);
                    showToast('取回失敗，請再試一次', { icon: 'ph-bold ph-warning' });
                    return;
                }
            }
            t.archived = false;
            showToast('已取回旅程', { icon: 'ph-bold ph-box-arrow-up' });
            adoptTrip(t);
        };
        // 永久刪除：只開放給「已封存」的旅程（測試行程／不再需要的舊行程），跟封存不同——這裡是真的從
        // Firestore 刪掉，沒有 undo，用來真正釋放空間。子集合（expenses）不會因為刪掉父文件就自動被清掉，
        // 必須自己撈出來逐筆刪除，否則變成撈不到、卻仍佔用空間的孤兒文件。
        const deleteArchivedTrip = async (t) => {
            if (!db) return;
            const ok = await appConfirm(
                `「${t.destination || '未命名行程'}」將被永久刪除，包含所有支出記錄，且無法復原，確定嗎？`,
                { title: '永久刪除旅程', danger: true, confirmText: '永久刪除' }
            );
            if (!ok) return;
            try {
                const expensesSnap = await getDocs(collection(db, 'trips', t.id, 'expenses'));
                await Promise.all(expensesSnap.docs.map(d => deleteDoc(d.ref)));
                await deleteDoc(doc(db, 'trips', t.id));
                allTrips.value = allTrips.value.filter(x => x.id !== t.id);
                tripList.value = tripList.value.filter(x => x.id !== t.id);
                saveTripList();
                showToast('已永久刪除旅程', { icon: 'ph-bold ph-trash' });
            } catch (e) {
                console.error('Delete trip failed', e);
                showToast('刪除失敗，請再試一次', { icon: 'ph-bold ph-warning' });
            }
        };
        watch(showTripMenu, (v) => { if (v && allTripsStatus.value === 'idle') loadAllTrips(); });

        const createNewTrip = () => {
            ignoreRemoteUpdate = true; // Prevent saving these resets to the current trip
            if (timeout) { clearTimeout(timeout); timeout = null; } // 取消舊旅程待存檔
            isEditing.value = false;
            showSetupModal.value = true;
            showTripMenu.value = false;
            newTripUseAsaTemplate.value = false;
            setup.value = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google', isAsaTemplate: false };
            weather.value.location = '';
            participantsStr.value = '';
            participants.value = [];
            members.value = [];
            if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
            expenses.value = [];
            newExpense.value = createExpenseDraft();
            isRateLoading.value = false;
            isSettingPasscode.value = false; passcodeDraftInput.value = '';
            nextTick(() => ignoreRemoteUpdate = false);
        };

        const joinTrip = () => {
            const input = joinTripUrl.value.trim();
            if (!input) { showToast('請貼上行程連結或 ID', { icon: 'ph-bold ph-warning' }); return; }
            // 從 URL 中提取 tripId，或直接使用輸入值作為 ID
            let tripId = input;
            try {
                const url = new URL(input);
                const params = new URLSearchParams(url.search);
                if (params.has('tripId')) tripId = params.get('tripId');
            } catch (e) {
                // 不是 URL 格式，直接當作 tripId 使用
            }
            if (!tripId) { showToast('無法解析行程 ID', { icon: 'ph-bold ph-warning' }); return; }
            // 檢查是否已存在
            if (tripList.value.find(t => t.id === tripId)) {
                switchTrip(tripId);
                showJoinInput.value = false;
                joinTripUrl.value = '';
                return;
            }
            // 加入行程列表
            tripList.value.unshift({ id: tripId, destination: '載入中...', startDate: '...', daysCount: 0 });
            saveTripList();
            switchTrip(tripId);
            showJoinInput.value = false;
            joinTripUrl.value = '';
        };

        // ---- Trip Passcode（MVP，前端驗證）--------------------------------------------------------
        // ⚠️ 安全性說明：這不是伺服器端存取控制。firestore.rules 目前只檢查「是否已匿名登入」
        // （見 firestore.rules `allow read: if request.auth != null`），任何知道 tripId、且完成匿名登入
        // 的使用者，理論上仍可直接用 Firebase SDK / REST API 讀到整份 trip 文件（包含這裡存的 passcodeHash）。
        // 這一層只是擋住「拿到分享連結但沒有密碼」的一般使用者，讓內容不會直接顯示在畫面上；
        // 要做到真正的存取控制需要後端（例如 Cloud Functions 驗證後核發臨時權限），這個純前端 + GitHub
        // Pages 架構沒有後端，所以先用這個當 MVP。密碼本身不明文存放：只存「亂數 salt + SHA-256 雜湊」。
        const tripLocked = ref(false);
        const passcodeInput = ref('');
        const passcodeError = ref('');
        const isUnlockingPasscode = ref(false);
        const passcodeDraftInput = ref(''); // 設定/變更密碼用的草稿欄位；明文只存在這台裝置的記憶體，存檔前就雜湊掉
        const isSettingPasscode = ref(false);
        const unlockStorageKey = (tripId) => tripId ? `wetravel_trip_unlocked_${tripId}` : null;
        const hashPasscode = async (passcode, salt) => {
            const bytes = new TextEncoder().encode(`${salt || ''}:${passcode}`);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const generatePasscodeSalt = () => {
            const arr = new Uint8Array(8);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const evaluateTripLock = () => {
            if (!setup.value.passcodeEnabled || !setup.value.passcodeHash) { tripLocked.value = false; return; }
            const key = unlockStorageKey(currentTripId.value);
            const savedHash = key ? localStorage.getItem(key) : null;
            tripLocked.value = savedHash !== setup.value.passcodeHash;
        };
        watch([currentTripId, () => setup.value.passcodeEnabled, () => setup.value.passcodeHash], evaluateTripLock, { immediate: true });
        watch(tripLocked, (locked) => { if (locked) { passcodeInput.value = ''; passcodeError.value = ''; } });
        const unlockTrip = async () => {
            passcodeError.value = '';
            if (!passcodeInput.value) { passcodeError.value = '請輸入密碼'; return; }
            isUnlockingPasscode.value = true;
            try {
                const hash = await hashPasscode(passcodeInput.value, setup.value.passcodeSalt);
                if (hash === setup.value.passcodeHash) {
                    const key = unlockStorageKey(currentTripId.value);
                    if (key) localStorage.setItem(key, hash);
                    tripLocked.value = false;
                    passcodeInput.value = '';
                } else {
                    passcodeError.value = '密碼不正確，請再試一次';
                }
            } finally {
                isUnlockingPasscode.value = false;
            }
        };
        const openPasscodeEditor = () => { passcodeDraftInput.value = ''; isSettingPasscode.value = true; };
        const cancelPasscodeEditor = () => { passcodeDraftInput.value = ''; isSettingPasscode.value = false; };
        const removeTripPasscode = async () => {
            const ok = await appConfirm('移除後，任何拿到分享連結的人都能直接看到這趟旅程的內容，確定嗎？', { title: '移除密碼保護', danger: true, confirmText: '移除' });
            if (!ok) return;
            setup.value.passcodeEnabled = false;
            setup.value.passcodeHash = '';
            setup.value.passcodeSalt = '';
            isSettingPasscode.value = false;
            passcodeDraftInput.value = '';
            showToast('已移除密碼保護', { icon: 'ph-bold ph-lock-open' });
        };
        // 存旅程設定時呼叫：如果使用者有在密碼欄位打新密碼，雜湊後寫進 setup；沒打就維持原狀，不會誤清空
        const applyPasscodeDraft = async () => {
            if (!isSettingPasscode.value) return;
            const val = passcodeDraftInput.value.trim();
            if (!val) return;
            const salt = generatePasscodeSalt();
            setup.value.passcodeSalt = salt;
            setup.value.passcodeHash = await hashPasscode(val, salt);
            setup.value.passcodeEnabled = true;
            passcodeDraftInput.value = '';
            isSettingPasscode.value = false;
        };

        let setupSnapshot = null;

        const openEditModal = () => {
            if (tripLocked.value) { showToast('請先輸入密碼解鎖旅程', { icon: 'ph-bold ph-lock-key' }); return; }
            const currentTrip = tripList.value.find(t => t.id === currentTripId.value);
            if (currentTrip) setup.value.destination = currentTrip.destination;
            setup.value.days = days.value.length;
            if (days.value.length > 0 && days.value[0].fullDate) setup.value.startDate = days.value[0].fullDate;
            setupSnapshot = JSON.parse(JSON.stringify(setup.value));
            isRateLoading.value = false;
            isSettingPasscode.value = false; passcodeDraftInput.value = '';
            isEditing.value = true; showSetupModal.value = true;
        };

        const cancelSetupModal = () => {
            if (isEditing.value && setupSnapshot) {
                ignoreRemoteUpdate = true;
                setup.value = JSON.parse(JSON.stringify(setupSnapshot));
                nextTick(() => ignoreRemoteUpdate = false);
            }
            setupSnapshot = null;
            isSettingPasscode.value = false; passcodeDraftInput.value = '';
            showSetupModal.value = false;
        };

        const initTrip = async () => {
            if (!setup.value.destination) { showToast('請先填寫目的地', { icon: 'ph-bold ph-warning' }); return; }
            await applyPasscodeDraft(); // 有打新密碼才會動 setup.passcodeHash/Salt/Enabled，沒打就不變

            if (isEditing.value && currentTripId.value) {
                if (setup.value.destination) {
                    if (weather.value && setup.value.destination !== weather.value.location) {
                        weather.value.location = setup.value.destination;
                        fetchWeather(weather.value.location);
                    }
                }
                exchangeRate.value = setup.value.rate;

                const trip = tripList.value.find(t => t.id === currentTripId.value);
                if (trip) {
                    trip.destination = setup.value.destination;
                    trip.daysCount = setup.value.days;
                    trip.startDate = setup.value.startDate;
                    saveTripList();
                }

                const [y, m, d] = setup.value.startDate.split('-').map(Number);
                const start = new Date(y, m - 1, d);
                const dNames = ['日', '一', '二', '三', '四', '五', '六'];
                const newDaysCount = setup.value.days;

                if (newDaysCount > days.value.length) {
                    const addCount = newDaysCount - days.value.length;
                    for (let i = 0; i < addCount; i++) { days.value.push({ items: [], flight: null, title: '自由活動' }); }
                } else if (newDaysCount < days.value.length) {
                    const ok = await appConfirm('天數減少，多出天數的行程將被刪除，確定嗎？', { title: '減少天數', danger: true, confirmText: '確定刪除' });
                    if (ok) { days.value.splice(newDaysCount); }
                    else { setup.value.days = days.value.length; }
                }

                days.value.forEach((day, i) => {
                    const curr = new Date(start); curr.setDate(start.getDate() + i);
                    const mm = curr.getMonth() + 1; const dd = curr.getDate(); const yyyy = curr.getFullYear();
                    const fullDate = `${yyyy}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`;
                    day.date = `${mm < 10 ? '0' + mm : mm}/${dd < 10 ? '0' + dd : dd} (${dNames[curr.getDay()]})`;
                    day.shortDate = `${mm}/${dd}`;
                    day.fullDate = fullDate;
                    if (!day.title) day.title = '行程規劃';
                });

                showSetupModal.value = false;
                return;
            }

            // 若選了 ASA San Diego 2026 範本，鎖定成固定的目的地/日期/天數/幣別，避免和固定行程對不上
            if (newTripUseAsaTemplate.value) { Object.assign(setup.value, ASA_SD_2026_TRIP_DEFAULTS); }

            if (weather.value && !weather.value.location) weather.value.location = setup.value.destination;
            if (weather.value && weather.value.location) fetchWeather(weather.value.location);

            const newId = generateId();
            const newTripMeta = { id: newId, destination: setup.value.destination, startDate: setup.value.startDate, daysCount: setup.value.days };
            const newDays = newTripUseAsaTemplate.value ? seedAsaSanDiego2026Days() : buildBlankDays(setup.value.startDate, setup.value.days);

            // 防止舊旅程資料被存入新旅程
            ignoreRemoteUpdate = true;
            // 取消舊旅程的待存檔計時器
            if (timeout) { clearTimeout(timeout); timeout = null; }

            // 先設定新旅程資料，再切換 ID
            days.value = newDays;
            expenses.value = [];
            savedLocations.value = newTripUseAsaTemplate.value ? [seedAsaSanDiego2026Poster()] : [];
            checklist.value = seedChecklist();
            customChecklistCategories.value = [];
            bookings.value = newTripUseAsaTemplate.value ? seedAsaSanDiego2026Bookings() : [];
            // ASA 2026 完整議程還沒公開，範本不帶入任何 session/venue（避免假造資料）；只有 My Presentation 有已知資訊可帶
            conferenceSessions.value = [];
            conferenceVenues.value = [];
            myPresentation.value = newTripUseAsaTemplate.value ? seedAsaSanDiego2026Presentation() : defaultPresentation();
            exchangeRate.value = setup.value.rate;
            // 成員已在 setup modal 收好（createNewTrip 開窗時已重置過），此處不可清空
            newExpense.value = createExpenseDraft();
            newExpense.value.paidByMemberId = memberIdByName(participants.value[0]) || '';
            applyFetchedRate(newExpense.value); // 旅程的 base currency 這時才真的定案，順便補一次匯率快照

            tripList.value.unshift(newTripMeta);
            saveTripList();

            switchTrip(newId);

            showSetupModal.value = false;
            viewMode.value = 'plan';

            // 等 onSnapshot 初始化完成後，解除鎖定並將新旅程資料存入 Firestore
            nextTick(() => {
                ignoreRemoteUpdate = false;
                debouncedSave();
            });
        };

        // 封存制：全 app 無真刪路徑，只標 archived 狀態（資料永留伺服器，可從「所有旅程」取回）。
        // 可逆動作照站內慣例：不彈確認，直接做＋undo toast（我的旅程、所有旅程兩處卡片共用）。
        const archiveTrip = (id) => {
            const idx = tripList.value.findIndex(t => t.id === id);
            const meta = idx !== -1 ? tripList.value.splice(idx, 1)[0] : null;
            if (meta) saveTripList();
            const cached = allTrips.value.find(t => t.id === id);
            if (cached) cached.archived = true;
            // merge 只動旗標，不碰行程內容
            if (db) setDoc(doc(db, 'trips', id), { archived: true }, { merge: true }).catch(e => console.error('Archive failed', e));
            showToast('已封存旅程', {
                icon: 'ph-bold ph-archive-box', undo: () => {
                    if (meta) { tripList.value.splice(Math.min(idx, tripList.value.length), 0, meta); saveTripList(); }
                    if (cached) cached.archived = false;
                    if (db) setDoc(doc(db, 'trips', id), { archived: false }, { merge: true }).catch(e => console.error('Unarchive failed', e));
                }
            });

            // 3. Handle UI switch
            if (currentTripId.value === id) {
                if (tripList.value.length > 0) {
                    switchTrip(tripList.value[0].id);
                } else {
                    days.value = [];
                    checklist.value = [];
                    customChecklistCategories.value = [];
                    if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
                    expenses.value = [];
                    members.value = [];
                    currentTripId.value = null;
                    showSetupModal.value = true;
                }
            }
        };

        const shareTrip = async () => {
            if (!currentTripId.value) return;
            const url = new URL(window.location.href);
            url.searchParams.set('tripId', currentTripId.value);
            const shareData = {
                title: `ASA San Diego Trip Planner: ${setup.value.destination}`,
                text: `一起來規劃 ${setup.value.destination} 的行程吧！`,
                url: url.toString()
            };

            if (navigator.share) {
                try { await navigator.share(shareData); } catch (e) { }
            } else {
                try {
                    await navigator.clipboard.writeText(url.toString());
                    showToast('連結已複製！傳給朋友即可共編', { icon: 'ph-bold ph-link' });
                } catch (e) {
                    appConfirm('自動複製失敗，請長按下方連結複製分享：', { title: '分享行程', link: url.toString(), showCancel: false, confirmText: '關閉' });
                }
            }
        };

        const switchTrip = async (id) => {
            currentTripId.value = id;
            viewMode.value = 'plan'; // Reset view to plan
            showTripMenu.value = false;
            window.scrollTo(0, 0);

            if (!db) return;

            if (unsubscribeTripData) { unsubscribeTripData(); unsubscribeTripData = null; }
            // expenses 子集合是獨立的 listener，不用等 trip 文件的 snapshot 回來才訂閱
            subscribeExpenses(id);

            isDataLoading.value = true;
            currentDayIdx.value = 0; // Reset only on initial trip switch
            let isFirstSnapshot = true;
            // Listen to 'trips' collection directly
            unsubscribeTripData = onSnapshot(doc(db, 'trips', id), (docSnap) => {
                isDataLoading.value = false;
                dbError.value = false;
                if (docSnap.exists()) {
                    // 本地有待存變更時跳過遠端快照（含自己存檔的 ACK echo）：整份文件 last-writer-wins，
                    // 稍後 setDoc 會把待存版本蓋上去；砍計時器再套遠端會吃掉 debounce 窗內的變更
                    if (timeout) return;
                    ignoreRemoteUpdate = true;
                    const data = docSnap.data();

                    // Ensure all items have IDs (Migration for old data)
                    if (data.days) {
                        data.days.forEach(day => {
                            if (day.items) {
                                day.items = day.items.filter(i => i); // Filter nulls
                                day.items.forEach(item => {
                                    if (!item.id) item.id = generateId();
                                });
                            }
                            migrateFlightToSegments(day); // 舊版單航段航班 → 多航段格式
                        });
                    }

                    days.value = data.days || [];
                    members.value = data.members || [];
                    savedLocations.value = (data.locations || []).filter(l => l);
                    savedLocations.value.forEach(l => { if (!l.prefs) l.prefs = {}; });

                    // 自訂分類要先載入，下面驗證 checklist 項目的 category 時才認得使用者自己加的分類
                    customChecklistCategories.value = (data.customChecklistCategories || []).filter(c => c);

                    // 舊旅程無 checklist → 空陣列（分頁顯示帶入模板的空狀態）；欄位缺漏防禦性補齊
                    checklist.value = (data.checklist || []).filter(i => i);
                    checklist.value.forEach(i => {
                        if (!i.id) i.id = generateId();
                        if (!i.checkedBy) i.checkedBy = {};
                        if (!allChecklistCategories.value.some(c => c.slug === i.category)) i.category = 'misc';
                        if (!LUGGAGE_META[i.luggage]) i.luggage = 'any';
                    });

                    bookings.value = (data.bookings || []).filter(b => b);
                    bookings.value.forEach(b => { if (!b.id) b.id = generateId(); migrateBookingFlightShape(b); });

                    // 修正舊資料：先前的 bug 會把勾了「同步到行程」的航班 booking 拆成一般 timeline item
                    // （type: 'transport'，sourceBookingId 指向該 flight booking）。航班現在一律走「航班資訊」
                    // 卡片，不應該留在 timeline 裡，載入時順手清掉，避免同一航班同時出現在訂位/航班資訊/一般行程三處。
                    const flightBookingIds = new Set(bookings.value.filter(b => b.type === 'flight').map(b => b.id));
                    if (flightBookingIds.size) {
                        days.value.forEach(day => {
                            if (day.items && day.items.length) {
                                day.items = day.items.filter(i => !(i.sourceBookingId && flightBookingIds.has(i.sourceBookingId)));
                            }
                        });
                    }

                    conferenceSessions.value = (data.conferenceSessions || []).filter(s => s);
                    conferenceSessions.value.forEach(s => { if (!s.id) s.id = generateId(); });
                    conferenceVenues.value = (data.conferenceVenues || []).filter(v => v);
                    conferenceVenues.value.forEach(v => { if (!v.id) v.id = generateId(); });
                    myPresentation.value = data.myPresentation || defaultPresentation();

                    // 舊版把 expenses 存成 trip 文件裡的一個陣列欄位；只在「這次切換旅程的第一份快照」搬一次，
                    // 避免每次 onSnapshot 觸發都重複跑搬遷（子集合一旦有文件，函式本身也會直接跳過）
                    if (isFirstSnapshot) migrateLegacyExpensesIfNeeded(id, data.expenses);

                    // 初次載入自動跳到「今天」（若今天落在行程日期區間內），並把當天 chip 捲入視野
                    if (isFirstSnapshot) {
                        isFirstSnapshot = false;
                        const now = new Date();
                        const mm = now.getMonth() + 1, dd = now.getDate();
                        const todayStr = `${now.getFullYear()}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`;
                        const todayIdx = days.value.findIndex(d => d.fullDate === todayStr);
                        if (todayIdx !== -1) {
                            currentDayIdx.value = todayIdx;
                            nextTick(() => {
                                const chip = document.querySelector(`[data-day-idx="${todayIdx}"]`);
                                if (chip) chip.scrollIntoView({ inline: 'center', block: 'nearest' });
                            });
                        }
                    }

                    // Prevent setup leakage from previous trip
                    const defaultSetup = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google', isAsaTemplate: false };
                    setup.value = data.setup || defaultSetup;
                    // 整份重置支出草稿，不沿用上一趟旅程選的幣別/分攤方式/分攤對象
                    newExpense.value = createExpenseDraft();
                    applyFetchedRate(newExpense.value); // 這趟旅程的 base currency 已載入，順便補一次匯率快照

                    if (data.rate) exchangeRate.value = data.rate;
                    if (data.users) {
                        participantsStr.value = data.users;
                    } else {
                        participantsStr.value = '';
                    }
                    updateParticipants();
                    if (!activeMembers.value.some(m => m.id === newExpense.value.paidByMemberId)) newExpense.value.paidByMemberId = memberIdByName(participants.value[0]) || '';
                    newExpense.value.splitAmongMemberIds = defaultSplitIds();

                    if (data.weather_loc) {
                        if (weather.value) weather.value.location = data.weather_loc;
                        fetchWeather(data.weather_loc);
                    } else if (setup.value.destination) {
                        if (weather.value) weather.value.location = setup.value.destination;
                        if (weather.value && weather.value.location) fetchWeather(weather.value.location);
                    }

                    // Update local trip list metadata
                    const currentMeta = tripList.value.find(t => t.id === currentTripId.value);
                    if (currentMeta) {
                        let changed = false;
                        if (currentMeta.destination !== setup.value.destination) { currentMeta.destination = setup.value.destination; changed = true; }
                        if (currentMeta.startDate !== setup.value.startDate) { currentMeta.startDate = setup.value.startDate; changed = true; }
                        if (currentMeta.daysCount !== setup.value.days) { currentMeta.daysCount = setup.value.days; changed = true; }
                        if (changed) saveTripList();
                    }

                    nextTick(() => ignoreRemoteUpdate = false);
                } else {
                    isDataLoading.value = false;
                    // 加入了不存在的行程（連結／ID 錯誤或已刪除）——給回饋並移除殭屍項
                    const meta = tripList.value.find(t => t.id === currentTripId.value);
                    if (meta && meta.destination === '載入中...') {
                        showToast('找不到此行程，可能連結錯誤或已被刪除', { icon: 'ph-bold ph-warning', duration: 3500 });
                        tripList.value = tripList.value.filter(t => t.id !== currentTripId.value);
                        saveTripList();
                        if (unsubscribeTripData) { unsubscribeTripData(); unsubscribeTripData = null; }
                        if (tripList.value.length > 0) {
                            switchTrip(tripList.value[0].id);
                        } else {
                            currentTripId.value = null;
                            showSetupModal.value = true;
                        }
                    }
                }
            }, (error) => {
                console.error("Snapshot error:", error);
                isDataLoading.value = false;
                if (error.code === 'not-found' || error.message.includes('database')) {
                    dbError.value = true;
                    dbErrorCode.value = error.code;
                }
                syncStatus.value = 'offline';
            });

            try { const url = new URL(window.location); url.searchParams.set('tripId', id); window.history.pushState({}, '', url); } catch (e) { }
        };

        let timeout = null;
        const debouncedSave = () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(async () => {
                timeout = null; // 進入存檔即不再算「待存」，onSnapshot 才不會被永久擋住
                if (!db || !currentTripId.value || ignoreRemoteUpdate) return;
                syncStatus.value = 'syncing';
                try {
                    const dataToSave = {
                        days: JSON.parse(JSON.stringify(days.value)),
                        // expenses 不再存在這裡——它們是 trips/{tripId}/expenses 子集合的獨立文件，
                        // 各自透過 addExpense/saveExpModal/deleteExpFromModal 直接寫入，不走這個整份文件的 debounce
                        members: JSON.parse(JSON.stringify(members.value)),
                        locations: savedLocations.value,
                        checklist: JSON.parse(JSON.stringify(checklist.value)),
                        customChecklistCategories: JSON.parse(JSON.stringify(customChecklistCategories.value)),
                        bookings: JSON.parse(JSON.stringify(bookings.value)),
                        conferenceSessions: JSON.parse(JSON.stringify(conferenceSessions.value)),
                        conferenceVenues: JSON.parse(JSON.stringify(conferenceVenues.value)),
                        myPresentation: myPresentation.value,
                        rate: exchangeRate.value,
                        users: participantsStr.value,
                        setup: setup.value,
                        weather_loc: weather.value.location,
                        lastUpdated: new Date().toISOString()
                    };
                    await setDoc(doc(db, 'trips', currentTripId.value), dataToSave, { merge: true });
                    dbError.value = false;
                    syncStatus.value = 'synced';
                } catch (e) {
                    console.error("Save error", e);
                    syncStatus.value = 'error';
                    if (e.code === 'not-found' || e.message.includes('database')) {
                        dbError.value = true;
                        dbErrorCode.value = e.code;
                    }
                }
            }, 1000);
        };

        watch([days, members, savedLocations, checklist, customChecklistCategories, bookings, conferenceSessions, conferenceVenues, myPresentation, exchangeRate, participantsStr, setup], () => {
            if (!ignoreRemoteUpdate && !(showSetupModal.value && !isEditing.value)) debouncedSave();
        }, { deep: true });

        watch(() => weather.value.location, () => {
            if (!ignoreRemoteUpdate && !(showSetupModal.value && !isEditing.value)) debouncedSave();
        });

        const initAuth = async () => {
            try {
                await signInAnonymously(auth);
                isLoggedIn.value = true;
            } catch (e) {
                // 匿名登入失敗（例如 Console 沒開匿名登入、或瀏覽器擋第三方儲存）：不能照舊把
                // isLoggedIn 設成 true——那會讓畫面看起來像登入成功，之後 Firestore 操作被規則
                // 擋下時只會顯示語意不明的「權限不足」，看不出真正原因其實是根本沒登入。
                console.error("Auth failed", e);
                dbError.value = true;
                dbErrorCode.value = 'auth-failed';
            }
        };

        const retryConnection = () => {
            window.location.reload();
        };

        onMounted(() => {
            // 瀏覽器離線/回線事件：跟 onSnapshot 的連線錯誤是兩條不同訊號來源，一起餵給同一顆 syncStatus，
            // 讓「目前斷網、還沒送出去」跟「Firestore 回傳錯誤」都能反映在畫面上，不用等使用者自己猜
            if (!navigator.onLine) syncStatus.value = 'offline';
            window.addEventListener('online', () => { if (syncStatus.value === 'offline') syncStatus.value = 'synced'; });
            window.addEventListener('offline', () => { syncStatus.value = 'offline'; });

            // 未填入自己的 Firebase 設定時，顯示設定指引，不初始化
            if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.startsWith('YOUR_')) {
                dbError.value = true;
                dbErrorCode.value = 'not-configured';
                return;
            }
            const app = initializeApp(firebaseConfig);
            auth = getAuth(app);

            // Modern Firestore initialization with multi-tab persistence support
            try {
                db = initializeFirestore(app, {
                    localCache: persistentLocalCache({
                        tabManager: persistentMultipleTabManager()
                    })
                });
            } catch (e) {
                console.warn('Firestore init error (likely persistent cache fallback):', e);
                // Fallback for browsers that might strictly fail custom init (though 10.7.1 should be fine)
                // If this fails, it usually falls back to default memory cache automatically.
            }

            initAuth();

            onAuthStateChanged(auth, (user) => {
                isLoggedIn.value = !!user;
                loadTripList();

                const urlParams = new URLSearchParams(window.location.search);
                const sharedTripId = urlParams.get('tripId');

                if (sharedTripId) {
                    if (!tripList.value.find(t => t.id === sharedTripId)) {
                        tripList.value.unshift({ id: sharedTripId, destination: '載入中...', startDate: '...', daysCount: 0 });
                        saveTripList();
                    }
                    switchTrip(sharedTripId);
                } else {
                    if (tripList.value.length > 0) {
                        switchTrip(tripList.value[0].id);
                    } else {
                        showSetupModal.value = true;
                    }
                }
            });

            watch(viewMode, (newVal) => { if (newVal === 'locations') { initSortableWhenReady(); } });

            // Vue 已掛載，App 外殼可見即散場啟動畫面（取代固定 2.8 秒假 splash）
            nextTick(() => { if (window.__hideSplash) window.__hideSplash(); });
        });

        return {
            viewMode, currentDayIdx, days, currentDay, currentDayTimelineItems, participants, participantsStr, updateParticipants,
            getExternalMapLink, removeFlight, addDay,
            currentDayMapEmbedUrl, currentDayMapSkippedCount, currentDayMapHasShortLinks,
            pocketListMapEmbedUrl, pocketListMapHasShortLinks, pocketListMapOmittedCount,
            addFlightSegment, removeFlightSegment, moveFlightSegment, formatFlightTime, isNextDayArrival, formatLayover, layoverLabel,
            revealedFlightConfirmations, toggleFlightConfirmation, maskConfirmation,
            expenses, visibleExpenses, newExpense, totalExpense, addExpense, expenseAmountTWD,
            usedCurrencies, settlementByCurrency, secondaryReferenceTotal, secondaryReferenceRate, exchangeRate,
            sharedOnlySettlementByCurrency, sharedOnlyNetTWD,
            combinedRateInput, combinedSettlementRate, combinedSettlementHasForeignCurrency, combinedSettlementMissingRate,
            combinedSettlementTransfers, combinedRatePlaceholder,
            twdSummary, moneyViewError, createEmptyMemberSummary, safeMembers,
            currentMemberId, expenseKind, expenseKindLabel, expenseVisibleToMember, expenseMemberShares,
            sharedExpensesList, myPersonalExpensesList, myReimbursementExpensesList, mySettlementByCurrency,
            calculateMemberTripCost, myTripCost, myTripTotalByCurrencyList, mySecondaryReferenceTotal,
            showTripTotalDetail,
            memberPersonalTotalsByCurrency, setExpenseType, EXPENSE_TYPE_OPTIONS, SHARED_SPLIT_METHODS,
            showOverallSettlement,
            fmtMoney, expenseNeedsRate, expensesMissingRate,
            EXPENSE_CATEGORIES, expenseCategoryLabel, expenseCategoryIcon, SPLIT_METHODS, splitMethodLabel,
            setSplitMethod, onExpensePayerChange, toggleSplitMember, customSplitTotal, customSplitRemaining,
            applyFetchedRate, isPayerInvalid, isSplitInvalid,
            members, activeMembers, memberIdByName, memberNameById,
            CURRENCY_SYMBOLS, currencyCodeOptions, symbolForCurrency,
            expenseSyncStatus, expModal, openExpModal, saveExpModal, deleteExpFromModal,
            reloadExpModalFromConflict, overwriteExpModalConflict,
            newParticipant, addParticipant, removeParticipant,
            updateExchangeRate, localDateStr, fmtExpDate,
            weather, getTimePeriod,
            showSetupModal, setup, initTrip, weatherDisplay, detectRate, isRateLoading, currencyLabel, currencySymbol, toggleFlightCard, getDotColor,
            isAsaConferenceTrip,
            newTripUseAsaTemplate, useAsaSanDiego2026Template, useBlankTripTemplate,
            showTripMenu, tripList, createNewTrip, switchTrip, archiveTrip, currentTripId,
            allTrips, allTripsStatus, showArchivedTrips, loadAllTrips, otherTrips, archivedTrips, adoptTrip, unarchiveTrip, deleteArchivedTrip,
            openEditModal, cancelSetupModal, isEditing, mapProviderLabel, amountInputRef, isAmountInvalid, itemInputRef, isItemInvalid, isUrl,
            tripLocked, passcodeInput, passcodeError, isUnlockingPasscode, unlockTrip,
            passcodeDraftInput, isSettingPasscode, openPasscodeEditor, cancelPasscodeEditor, removeTripPasscode,
            bookings, sortedBookings, BOOKING_TYPE_META, bookingModal, openBookingModal, saveBookingModal, deleteBookingFromModal,
            switchBookingDraftType, createBookingFlightSegment, formatBookingSegDateTime, bookingLayover,
            conferenceSubView, conferenceSessions, conferenceVenues, myPresentation,
            SESSION_TYPES, TOPIC_CATEGORIES, SESSION_PRIORITY_META, sessionTypeLabel, topicCategoryLabel, isRecommendedCandidate,
            sessionSearchQuery, sessionCategoryFilter, filteredSessions,
            isSessionInItinerary, addSessionToItinerary, removeSessionFromItinerary, conflictingSessionIds,
            sessionModal, openSessionModal, saveSessionModal, deleteSessionFromModal,
            importSessionText, importSessionFormat, importSessions,
            venueModal, openVenueModal, saveVenueModal, deleteVenueFromModal,
            revealedBookingConfirmations, toggleBookingConfirmation,
            editingState,
            savedLocations,
            updateRateByCurrency,
            toggleWeatherEdit, isWeatherEditing, updateWeatherLocation, weatherInputRef,
            loadTripList,
            isDataLoading, isLoggedIn, dbError, dbErrorCode, dbErrorMessage, retryConnection, syncStatus,
            shareTrip, showShareModal,
            showJoinInput, joinTripUrl, joinTrip,
            dialog, dialogAnswer, toast, undoToast,
            itemModal, openItemModal, saveItemModal, deleteItemFromModal,
            itemTypeLabel,
            textImportModal, openTextImportModal, closeTextImportModal, backToPasteStep,
            TEXT_IMPORT_PROMPT, copyTextImportPrompt,
            previewTextImport, toggleAllImportRows, toggleAllFlightJourneys, confirmTextImport, undoLastImport, lastImportBatch,
            locModal, openLocModal, saveLocModal, deleteLocFromModal,
            LOC_PREF_ORDER, LOC_PREF_META, setLocPref, otherMemberPrefs, locConsensus,
            isLocInItinerary, locDayPicker, openLocDayPicker, addLocToDay, removeLocFromItinerary,
            checklist, collapsedCats, toggleCat, checklistMembers, memberLabel, toggleCheck,
            activeChecklistMember, chooseChecklistMember,
            myChecklistProgress, checklistByCategory, seedDefaultChecklist, resetChecklist,
            checkModal, openCheckModal, saveCheckModal, deleteCheckFromModal, isCheckNameInvalid,
            LUGGAGE_META, allChecklistCategories, addChecklistCategory
        };
    }
})

// ---- 全域防呆（需求 G）：任何一個沒被個別 computed 的 try/catch 接住的 render/watcher 錯誤，
// 最後都會經過這裡——一律 console.error 完整錯誤方便排查，不讓一顆沒接住的例外直接讓整頁變白畫面。
// 個別畫面（例如記帳頁）自己的 try/catch 永遠是第一線，這裡只是最後一道保險。
app.config.errorHandler = (err, instance, info) => {
    console.error('[App] 未捕捉的錯誤', err, info);
};

app.mount('#app')
