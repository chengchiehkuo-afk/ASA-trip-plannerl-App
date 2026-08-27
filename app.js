
import { createApp, ref, computed, watch, onMounted, nextTick, reactive } from './vendor/vue-3.5.13.esm-browser.prod.js'

// Firebase 設定改由外部檔案提供：自架者請編輯 firebase-config.js
import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeFirestore, collection, doc, setDoc, onSnapshot, getDocs, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { CHECKLIST_CATEGORIES, LUGGAGE_META, CHECKLIST_TEMPLATE } from './checklist-data.js';
import { ASA_SD_2026_TRIP_DEFAULTS, ASA_SD_2026_ITINERARY, ASA_SD_2026_POSTER, ASA_SD_2026_FLIGHTS } from './asa-trip-template.js';

createApp({
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
            'not-configured': '尚未設定 Firebase：請編輯 firebase-config.js，填入你自己的 Firebase 專案設定（步驟見 README）。'
        };

        const dbErrorMessage = computed(() => errorMap[dbErrorCode.value] || `發生未知錯誤 (${dbErrorCode.value})`);

        let db = null;
        let auth = null;
        let unsubscribeTripData = null;
        let ignoreRemoteUpdate = false;

        const editingState = reactive({ dayTitle: false, flight: false });

        const days = ref([]);
        const savedLocations = ref([]);
        const expenses = ref([]);
        const checklist = ref([]);
        const bookings = ref([]); // 訂位/票券總表：hotel / flight / restaurant / ticket / other，見「口袋名單」下方新增的 bookingModal
        const collapsedCats = reactive({});
        const participants = ref([]);
        const participantsStr = ref('');
        const exchangeRate = ref(0.215);
        const newExpense = ref({ item: '', amount: '', payer: '' });

        const isRateLoading = ref(false);
        const weather = ref({ temp: null, icon: 'ph-sun', code: 0, location: '', daily: [] });
        const isWeatherEditing = ref(false);
        const setup = ref({ destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google' });

        const currentDay = computed(() => days.value[currentDayIdx.value] || { items: [], flight: null, date: '', title: '' });
        const totalExpense = computed(() => expenses.value.reduce((sum, item) => sum + item.amount, 0));
        const paidByPerson = computed(() => {
            const map = {}; participants.value.forEach(p => map[p] = 0);
            expenses.value.forEach(e => { if (map[e.payer] === undefined) map[e.payer] = 0; map[e.payer] += e.amount; }); return map;
        });
        // 成員新增/刪除（直接同步 participantsStr 供存檔；participants 為顯示來源）
        const newParticipant = ref('');
        const addParticipant = () => {
            const name = newParticipant.value.trim();
            if (!name || participants.value.includes(name)) { newParticipant.value = ''; return; }
            participants.value.push(name);
            participantsStr.value = participants.value.join(', ');
            if (!newExpense.value.payer) newExpense.value.payer = name;
            newParticipant.value = '';
        };
        const removeParticipant = (name) => {
            participants.value = participants.value.filter(p => p !== name);
            participantsStr.value = participants.value.join(', ');
            if (newExpense.value.payer === name) newExpense.value.payer = participants.value[0] || '';
        };
        const currencyLabel = computed(() => setup.value.currency || '外幣');
        const currencySymbol = computed(() => { const map = { 'JPY': '¥', 'CNY': '¥', 'USD': '$', 'EUR': '€', 'KRW': '₩', 'GBP': '£', 'TWD': 'NT$', 'HKD': 'HK$', 'THB': '฿', 'VND': '₫' }; return map[setup.value.currency] || '$'; });
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
        const addFlightSegment = (journey) => { if (journey) journey.segments.push(createFlightSegment()); };
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
        // 簡單轉機時間計算：兩個 datetime-local 字串直接相減；資料不全或算出負值就不顯示，改讓使用者自己寫在 notes
        const formatLayover = (arrPrev, depNext) => {
            if (!arrPrev || !depNext) return '';
            const a = new Date(arrPrev), b = new Date(depNext);
            if (isNaN(a) || isNaN(b)) return '';
            const diffMin = Math.round((b - a) / 60000);
            if (diffMin <= 0) return '';
            const h = Math.floor(diffMin / 60), m = diffMin % 60;
            return `轉機 ${h > 0 ? h + ' 小時 ' : ''}${m} 分鐘`;
        };
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
        const getDotColor = (t) => { if (t === 'food') return 'bg-orange-400 border-orange-100 ring-2 ring-orange-50'; if (t === 'shop') return 'bg-pink-400 border-pink-100 ring-2 ring-pink-50'; if (t === 'transport' || t === 'flight') return 'bg-blue-500 border-blue-100 ring-2 ring-blue-50'; if (t === 'hotel') return 'bg-indigo-400 border-indigo-100 ring-2 ring-indigo-50'; if (t === 'conference') return 'bg-violet-500 border-violet-100 ring-2 ring-violet-50'; return 'bg-primary-500 border-primary-100 ring-2 ring-primary-50'; };
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
                // prefs 是各旅伴直接點卡片上的按鈕存的（見 setLocPref），不透過這個編輯彈窗；
                // 排除它再 assign，避免拿彈窗打開當下的舊快照蓋掉旅伴同時按的偏好
                if (target) { const { prefs, ...rest } = locModal.draft; Object.assign(target, rest); }
            } else {
                savedLocations.value.push({ ...locModal.draft });
            }
            locModal.show = false;
        };
        const deleteLocFromModal = () => {
            locModal.show = false;
            const idx = savedLocations.value.findIndex(l => l.id === locModal.targetId);
            if (idx === -1) return;
            const removed = savedLocations.value.splice(idx, 1)[0];
            showToast('已刪除地點', { icon: 'ph-bold ph-trash', undo: () => { savedLocations.value.splice(Math.min(idx, savedLocations.value.length), 0, removed); } });
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
        const useAsaSanDiego2026Template = () => {
            newTripUseAsaTemplate.value = true;
            Object.assign(setup.value, ASA_SD_2026_TRIP_DEFAULTS);
            if (weather.value) weather.value.location = ASA_SD_2026_TRIP_DEFAULTS.destination;
        };
        const useBlankTripTemplate = () => {
            newTripUseAsaTemplate.value = false;
            setup.value = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google' };
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
        // 分類進度跟著目前選中角色算（多人並排時代曾是「全員勾完才算」，已廢）
        const checklistByCategory = computed(() => CHECKLIST_CATEGORIES
            .map(cat => {
                const items = checklist.value.filter(i => i.category === cat.slug);
                return { ...cat, items, done: items.filter(i => i.checkedBy && i.checkedBy[activeChecklistMember.value]).length };
            })
            .filter(cat => cat.items.length));
        const toggleCat = (slug) => { collapsedCats[slug] = !collapsedCats[slug]; };

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

        // 記帳：快速新增保留內聯表單；既有支出點列開彈窗編輯
        const itemInputRef = ref(null);
        const isItemInvalid = ref(false);
        const addExpense = () => {
            if (!newExpense.value.item) { isItemInvalid.value = true; nextTick(() => { itemInputRef.value?.focus(); }); return; }
            if (!newExpense.value.amount) { isAmountInvalid.value = true; nextTick(() => { amountInputRef.value?.focus(); }); return; }
            expenses.value.unshift({ ...newExpense.value, id: generateId(), date: localDateStr() });
            newExpense.value.item = ''; newExpense.value.amount = ''; isItemInvalid.value = false; isAmountInvalid.value = false;
        };
        const expModal = reactive({ show: false, targetId: null, draft: null });
        const openExpModal = (exp) => {
            expModal.targetId = exp.id;
            expModal.draft = JSON.parse(JSON.stringify(exp));
            expModal.show = true;
        };
        const saveExpModal = () => {
            const target = expenses.value.find(e => e.id === expModal.targetId);
            if (target) Object.assign(target, expModal.draft);
            expModal.show = false;
        };
        const deleteExpFromModal = () => {
            expModal.show = false;
            const idx = expenses.value.findIndex(e => e.id === expModal.targetId);
            if (idx === -1) return;
            const removed = expenses.value.splice(idx, 1)[0];
            showToast('已刪除支出', { icon: 'ph-bold ph-trash', undo: () => { expenses.value.splice(Math.min(idx, expenses.value.length), 0, removed); } });
        };

        // ---- 訂位與票券總表（Bookings）：集中管理飯店/航班/餐廳訂位/票券，跟 itinerary/expenses 是各自獨立的資料，互不影響 ----
        const BOOKING_TYPE_META = {
            hotel: { label: '飯店', icon: 'ph-bold ph-bed' },
            flight: { label: '航班', icon: 'ph-bold ph-airplane-tilt' },
            restaurant: { label: '餐廳訂位', icon: 'ph-bold ph-fork-knife' },
            ticket: { label: '票券', icon: 'ph-bold ph-ticket' },
            other: { label: '其他', icon: 'ph-bold ph-bookmark-simple' },
        };
        const bookingModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openBookingModal = (b = null) => {
            if (b) {
                bookingModal.mode = 'edit'; bookingModal.targetId = b.id;
                bookingModal.draft = JSON.parse(JSON.stringify(b));
            } else {
                bookingModal.mode = 'add'; bookingModal.targetId = null;
                bookingModal.draft = { id: generateId(), type: 'hotel', title: '', date: '', time: '', confirmationNumber: '', bookedBy: activeChecklistMember.value || '', cost: '', location: '', notes: '' };
            }
            bookingModal.show = true;
            if (!b) nextTick(() => { document.querySelector('.js-booking-title')?.focus(); });
        };
        const saveBookingModal = () => {
            if (bookingModal.mode === 'edit') {
                const target = bookings.value.find(b => b.id === bookingModal.targetId);
                if (target) Object.assign(target, bookingModal.draft);
            } else {
                bookings.value.push({ ...bookingModal.draft });
            }
            bookingModal.show = false;
        };
        const deleteBookingFromModal = () => {
            bookingModal.show = false;
            const idx = bookings.value.findIndex(b => b.id === bookingModal.targetId);
            if (idx === -1) return;
            const removed = bookings.value.splice(idx, 1)[0];
            showToast('已刪除訂位/票券', { icon: 'ph-bold ph-trash', undo: () => { bookings.value.splice(Math.min(idx, bookings.value.length), 0, removed); } });
        };
        const sortedBookings = computed(() => [...bookings.value].sort((a, b) => `${a.date || ''}${a.time || ''}`.localeCompare(`${b.date || ''}${b.time || ''}`)));
        // 確認碼/票券號碼預設遮蔽，跟航班段共用同一套遮蔽 UI 邏輯，但分開存避免 id 混淆
        const revealedBookingConfirmations = reactive({});
        const toggleBookingConfirmation = (bookingId) => { revealedBookingConfirmations[bookingId] = !revealedBookingConfirmations[bookingId]; };
        const updateExchangeRate = () => { if (setup.value) setup.value.rate = exchangeRate.value; };

        const getExternalMapLink = (loc) => { if (!loc) return '#'; if (isUrl(loc)) return loc; const encodedLoc = encodeURIComponent(loc); if (setup.value.mapProvider === 'naver') return `https://map.naver.com/v5/search/${encodedLoc}`; else if (setup.value.mapProvider === 'amap') return `https://www.amap.com/search?query=${encodedLoc}`; else return `https://www.google.com/maps/search/?api=1&query=${encodedLoc}`; };
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
        watch(showTripMenu, (v) => { if (v && allTripsStatus.value === 'idle') loadAllTrips(); });

        const createNewTrip = () => {
            ignoreRemoteUpdate = true; // Prevent saving these resets to the current trip
            if (timeout) { clearTimeout(timeout); timeout = null; } // 取消舊旅程待存檔
            isEditing.value = false;
            showSetupModal.value = true;
            showTripMenu.value = false;
            newTripUseAsaTemplate.value = false;
            setup.value = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google' };
            weather.value.location = '';
            participantsStr.value = '';
            participants.value = [];
            newExpense.value.payer = '';
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
            bookings.value = [];
            exchangeRate.value = setup.value.rate;
            // 成員已在 setup modal 收好（createNewTrip 開窗時已重置過），此處不可清空
            if (!participants.value.includes(newExpense.value.payer)) newExpense.value.payer = participants.value[0] || '';

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
                    expenses.value = data.expenses || [];
                    expenses.value.forEach(e => { if (e && !e.id) e.id = generateId(); });
                    savedLocations.value = (data.locations || []).filter(l => l);
                    savedLocations.value.forEach(l => { if (!l.prefs) l.prefs = {}; });

                    // 舊旅程無 checklist → 空陣列（分頁顯示帶入模板的空狀態）；欄位缺漏防禦性補齊
                    checklist.value = (data.checklist || []).filter(i => i);
                    checklist.value.forEach(i => {
                        if (!i.id) i.id = generateId();
                        if (!i.checkedBy) i.checkedBy = {};
                        if (!CHECKLIST_CATEGORIES.some(c => c.slug === i.category)) i.category = 'misc';
                        if (!LUGGAGE_META[i.luggage]) i.luggage = 'any';
                    });

                    bookings.value = (data.bookings || []).filter(b => b);
                    bookings.value.forEach(b => { if (!b.id) b.id = generateId(); });

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
                    const defaultSetup = { destination: '', startDate: '2026-10-14', days: 8, rate: 1, currency: 'USD', langCode: 'en', langName: '英文', mapProvider: 'google' };
                    setup.value = data.setup || defaultSetup;

                    if (data.rate) exchangeRate.value = data.rate;
                    if (data.users) {
                        participantsStr.value = data.users;
                    } else {
                        participantsStr.value = '';
                    }
                    updateParticipants();
                    if (!participants.value.includes(newExpense.value.payer)) newExpense.value.payer = participants.value[0] || '';

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
                        expenses: expenses.value,
                        locations: savedLocations.value,
                        checklist: JSON.parse(JSON.stringify(checklist.value)),
                        bookings: JSON.parse(JSON.stringify(bookings.value)),
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
                    if (e.code === 'not-found' || e.message.includes('database')) {
                        dbError.value = true;
                        dbErrorCode.value = e.code;
                    }
                }
            }, 1000);
        };

        watch([days, expenses, savedLocations, checklist, bookings, exchangeRate, participantsStr, setup], () => {
            if (!ignoreRemoteUpdate && !(showSetupModal.value && !isEditing.value)) debouncedSave();
        }, { deep: true });

        watch(() => weather.value.location, () => {
            if (!ignoreRemoteUpdate && !(showSetupModal.value && !isEditing.value)) debouncedSave();
        });

        const initAuth = async () => {
            try {
                await signInAnonymously(auth);
            } catch (e) { console.error("Auth failed", e); }
            finally {
                isLoggedIn.value = true;
            }
        };

        const retryConnection = () => {
            window.location.reload();
        };

        onMounted(() => {
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
            viewMode, currentDayIdx, days, currentDay, participants, participantsStr, updateParticipants,
            getExternalMapLink, removeFlight, addDay,
            addFlightSegment, removeFlightSegment, moveFlightSegment, formatFlightTime, isNextDayArrival, formatLayover,
            revealedFlightConfirmations, toggleFlightConfirmation, maskConfirmation,
            expenses, newExpense, totalExpense, addExpense,
            paidByPerson, exchangeRate,
            newParticipant, addParticipant, removeParticipant,
            updateExchangeRate, localDateStr, fmtExpDate,
            weather, getTimePeriod,
            showSetupModal, setup, initTrip, weatherDisplay, detectRate, isRateLoading, currencyLabel, currencySymbol, toggleFlightCard, getDotColor,
            newTripUseAsaTemplate, useAsaSanDiego2026Template, useBlankTripTemplate,
            showTripMenu, tripList, createNewTrip, switchTrip, archiveTrip, currentTripId,
            allTrips, allTripsStatus, showArchivedTrips, loadAllTrips, otherTrips, archivedTrips, adoptTrip, unarchiveTrip,
            openEditModal, cancelSetupModal, isEditing, mapProviderLabel, amountInputRef, isAmountInvalid, itemInputRef, isItemInvalid, isUrl,
            tripLocked, passcodeInput, passcodeError, isUnlockingPasscode, unlockTrip,
            passcodeDraftInput, isSettingPasscode, openPasscodeEditor, cancelPasscodeEditor, removeTripPasscode,
            bookings, sortedBookings, BOOKING_TYPE_META, bookingModal, openBookingModal, saveBookingModal, deleteBookingFromModal,
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
            locModal, openLocModal, saveLocModal, deleteLocFromModal,
            LOC_PREF_ORDER, LOC_PREF_META, setLocPref, otherMemberPrefs, locConsensus,
            expModal, openExpModal, saveExpModal, deleteExpFromModal,
            checklist, collapsedCats, toggleCat, checklistMembers, memberLabel, toggleCheck,
            activeChecklistMember, chooseChecklistMember,
            myChecklistProgress, checklistByCategory, seedDefaultChecklist, resetChecklist,
            checkModal, openCheckModal, saveCheckModal, deleteCheckFromModal, isCheckNameInvalid,
            CHECKLIST_CATEGORIES, LUGGAGE_META
        };
    }
}).mount('#app')
