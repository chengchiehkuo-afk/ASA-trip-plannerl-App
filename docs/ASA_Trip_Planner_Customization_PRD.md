# ASA San Diego 2026 旅遊協作與會議助手網站規格書

版本：v1.0  
建立日期：2026-08-27  
專案基礎：Fork 自 `benson5566/WeTravel-App`  
建議專案名稱：`ASA-trip-planner-App`

---

## 1. 專案目標

建立一個可以與旅伴共同使用的旅遊網站，用於 2026 ASA San Diego 行程。網站需要整合：

1. 旅遊行程規劃
2. 景點、餐廳、飯店與交通安排
3. Google Maps 導航連結
4. 記帳與分帳
5. 旅程總花費統計
6. 訂位與票券管理
7. ASA 會議議程、推薦課程、場地索引
8. Poster presentation 資訊
9. 會議筆記與會後匯出
10. 手機可用、可分享給同伴共同編輯

本專案不是單純 itinerary，也不是單純分帳工具，而是：

> Shared travel planner + expense splitter + ASA conference assistant

核心問題：

> Where are we going? What are we attending? Who paid? Who owes whom?

---

## 2. 使用情境

### 2.1 使用者

- 使用者 A：我
- 使用者 B：旅伴

### 2.2 旅程基本資料

| 項目 | 內容 |
|---|---|
| 旅程名稱 | ASA San Diego 2026 |
| 目的地 | San Diego, California, USA |
| 日期 | 2026-10-14 至 2026-10-21 |
| 人數 | 2 人 |
| 主要目的 | ASA annual meeting + short trip |

### 2.3 航班資訊

| 日期 | 航班 / 事件 | 時間 | 地點 |
|---|---|---:|---|
| 2026-10-14 | 抵達 San Diego | 12:23 | San Diego Airport, SAN |
| 2026-10-21 | 離開 San Diego | 18:51 | San Diego Airport, SAN |

### 2.4 住宿資訊

| 日期 | 飯店 | 用途 |
|---|---|---|
| 2026-10-14 至 2026-10-16 | Empress Hotel La Jolla | 前段旅遊、La Jolla 海邊 |
| 2026-10-16 至 2026-10-20 | Embassy Suites by Hilton San Diego Bay Downtown | ASA 會議期間住宿 |
| 2026-10-20 至 2026-10-21 | Holiday Inn Express San Diego Airport–Old Town by IHG | 最後一晚、Old Town 與機場接駁 |

---

## 3. 技術基礎與建議策略

### 3.1 建議直接使用 WeTravel-App 作為基礎

目前建議不要從零建立 Next.js / Supabase 專案，而是先使用已 fork 的 WeTravel-App。

原因：

- 已有旅遊行程規劃功能
- 已有即時協作功能
- 已有分享連結功能
- 已有記帳與分帳功能
- 已有 PWA，可加到手機主畫面
- 已有 Firebase Firestore 架構
- 可用 GitHub Pages 免費部署
- 對初學者較友善

### 3.2 原始技術架構

| 層級 | 技術 |
|---|---|
| 前端 | Vue 3 CDN ESM |
| 樣式 | Tailwind CSS CDN |
| 後端 | Firebase Firestore |
| 登入 | Firebase Anonymous Auth |
| 部署 | GitHub Pages 或 Firebase Hosting |
| PWA | Service Worker + manifest |
| 地圖 | Google Maps / Naver Map / 高德地圖導航連結 |
| 匯率 | Exchange rate API |

### 3.3 第一階段策略

第一階段不重寫架構，只做客製化：

1. 接上自己的 Firebase
2. 開啟 GitHub Pages
3. 建立 ASA San Diego 2026 旅程
4. 輸入住宿、航班、行程、已知費用
5. 新增或修改分類以支援 ASA conference items
6. 測試同伴共同編輯與分帳

---

## 4. 功能總覽

### 4.1 Travel 模組

- 行程共同編輯
- 每日時間軸
- 景點 / 餐廳 / 飯店 / 交通 / 會議分類
- Google Maps 導航連結
- 口袋名單 / Wishlist
- 飯店 anchor
- 航班資訊
- 訂位與票券管理
- Today Mode
- 路線與地點備註

### 4.2 Expense 模組

- 記帳
- 分帳
- 個人支出
- 兩人平分
- 自訂比例
- 指定金額
- 小費計算
- 匯率換算
- 結算摘要
- 收據上傳
- 匯出 CSV / Excel / PDF

### 4.3 Conference 模組

- ASA 議程管理
- 推薦課程
- 我的 ASA schedule
- 場地 / 房間索引
- Poster presentation 專區
- Session notes
- 時間衝突提醒
- 會後筆記匯出 Markdown

### 4.4 明確不加入的功能

以下功能暫時不加入：

- 餐廳投票功能
- 天氣功能
- 穿著備註功能

---

## 5. Travel 模組詳細規格

### 5.1 Itinerary 每日行程

每個行程項目應包含：

| 欄位 | 說明 |
|---|---|
| date | 日期 |
| startTime | 開始時間 |
| endTime | 結束時間 |
| title | 行程名稱 |
| type | 類型 |
| locationName | 地點名稱 |
| address | 地址 |
| mapUrl | Google Maps 連結 |
| notes | 備註 |
| status | confirmed / tentative / backup / cancelled |
| createdBy | 建立者 |
| updatedAt | 更新時間 |

### 5.2 行程類型

建議類型：

- hotel
- flight
- transport
- attraction
- restaurant
- conference
- poster
- shopping
- rest
- other

### 5.3 每日行程初稿

#### 2026-10-14｜Arrival + La Jolla

- 12:23 Arrive at San Diego Airport
- Uber / Lyft to Empress Hotel La Jolla
- Check-in / rest
- La Jolla Cove / Children’s Pool / Seal Rock
- Dinner in La Jolla

#### 2026-10-15｜La Jolla Full Day

- Breakfast / coffee
- La Jolla Cove + Coast Walk Trail
- Lunch
- Optional: La Jolla Shores / Sea Cave Kayak / Birch Aquarium
- Dinner in La Jolla

#### 2026-10-16｜La Jolla to Downtown / ASA Start

- Breakfast / final walk in La Jolla
- Check-out from Empress Hotel La Jolla
- Move to Embassy Suites by Hilton San Diego Bay Downtown
- ASA registration / badge pickup
- Seaport Village / waterfront
- Dinner near waterfront or Gaslamp Quarter

#### 2026-10-17 至 2026-10-20｜ASA Meeting Days

- ASA sessions first priority
- Insert flexible half-day activities when available:
  - USS Midway Museum
  - Balboa Park
  - Little Italy dinner
  - Seaport Village
  - Gaslamp Quarter

#### 2026-10-20｜Downtown to Old Town

- ASA final sessions if needed
- Check-out from Embassy Suites
- Move to Holiday Inn Express San Diego Airport–Old Town
- Old Town State Historic Park
- Mexican dinner in Old Town

#### 2026-10-21｜Old Town + Airport

- Check-out and luggage storage
- Old Town State Historic Park / Bazaar del Mundo
- Lunch / coffee
- Return hotel to pick up luggage
- Shuttle / Uber / San Diego Flyer to SAN
- 18:51 departure from SAN

---

## 6. Map / Location 功能

### 6.1 MVP

第一版可先使用地點名稱與 Google Maps 搜尋連結。

範例：

```text
https://www.google.com/maps/search/?api=1&query=La+Jolla+Cove
```

### 6.2 進階版

之後若要強化，可加入 Google Places API：

- Place Autocomplete
- Place Details
- 正式地址
- Google place ID
- 經緯度
- 地點分類
- Google Maps URL

### 6.3 Route 功能

MVP 可先提供：

- Open in Google Maps
- Open today’s route
- Hotel to next destination

不需要一開始就做網站內完整路線規劃。

---

## 7. Expense / Split 模組詳細規格

### 7.1 支出欄位

每筆支出包含：

| 欄位 | 說明 |
|---|---|
| date | 日期 |
| title | 項目名稱 |
| category | 類別 |
| amount | 金額 |
| currency | 幣別 |
| exchangeRate | 匯率 |
| paidBy | 付款者 |
| splitBetween | 分攤成員 |
| splitMethod | 分攤方式 |
| note | 備註 |
| receipt | 收據照片，可選 |

### 7.2 支出類別

- hotel
- food
- coffee
- transport
- ticket
- shopping
- conference
- other

### 7.3 分帳方式

必須支援：

1. Equal split：兩人平分
2. Personal expense：個人支出，不分帳
3. Custom percentage：自訂比例
4. Exact amount：指定金額

### 7.4 分帳邏輯

基本邏輯：

```text
每個人應付金額 = 所有支出中分配到該人的 share 加總
每個人已付金額 = paidBy 為該人的支出加總
Balance = 已付金額 - 應付金額
```

若 A 的 Balance 為負，代表 A 欠款。  
若 B 的 Balance 為正，代表 B 應收款。

### 7.5 結算顯示

範例：

```text
目前結算：
你需要付給同伴 USD 436.50
```

### 7.6 Dashboard 顯示

Dashboard 顯示：

- Total trip expense
- Hotel expense
- Food expense
- Transport expense
- Paid by me
- Paid by companion
- Current settlement

---

## 8. 訂位與票券管理

### 8.1 Bookings / Reservations

新增一個管理區塊，記錄重要預訂資訊。

欄位：

| 欄位 | 說明 |
|---|---|
| type | hotel / flight / restaurant / ticket / conference |
| title | 名稱 |
| date | 日期 |
| time | 時間 |
| confirmationNumber | 確認碼 |
| bookedBy | 誰預訂 |
| cost | 費用 |
| location | 地點 |
| note | 備註 |
| attachment | 訂位截圖或 PDF，可選 |

### 8.2 初始資料

#### Hotels

- Empress Hotel La Jolla
- Embassy Suites by Hilton San Diego Bay Downtown
- Holiday Inn Express San Diego Airport–Old Town by IHG

#### Flights

- Arrive SAN 2026-10-14 12:23
- Depart SAN 2026-10-21 18:51

#### Conference

- ASA annual meeting registration
- Poster presentation details, pending official notification

---

## 9. Wishlist / 口袋名單

Wishlist 用來放尚未排入正式行程的候選地點或活動。

### 9.1 欄位

| 欄位 | 說明 |
|---|---|
| title | 名稱 |
| type | attraction / restaurant / conference / shopping / other |
| location | 地點 |
| mapUrl | 地圖連結 |
| status | want / planned / backup / cancelled |
| note | 備註 |

### 9.2 範例

- La Jolla Sea Cave Kayak
- Birch Aquarium
- USS Midway Museum
- Balboa Park
- Little Italy dinner
- Cafe Coyote
- Casa Guadalajara
- Recommended ASA airway session
- Recommended ASA cardiac anesthesia / TEE session

---

## 10. ASA Conference Assistant

### 10.1 目標

將 ASA 會議資訊整合到旅遊網站中，讓使用者可在同一個網站管理：

- ASA 議程
- 推薦課程
- 我的會議 schedule
- 會場與房間索引
- Poster presentation 資訊
- Session notes
- 會後筆記匯出

### 10.2 Conference agenda item 欄位

| 欄位 | 說明 |
|---|---|
| date | 日期 |
| startTime | 開始時間 |
| endTime | 結束時間 |
| title | 課程名稱 |
| sessionType | lecture / workshop / poster / panel / PBLD / exhibit / other |
| topicCategory | airway / thoracic / cardiac / TEE / regional / pain / research / AI / QI / critical care / other |
| location | 房間或會場 |
| speaker | 講者，可選 |
| priority | must attend / interested / backup |
| status | planned / attended / skipped |
| notes | 備註 |
| tags | 標籤 |

### 10.3 推薦課程分類

根據使用者背景，推薦課程分類應包含：

1. Airway
2. Difficult airway
3. Thoracic anesthesia
4. One-lung ventilation
5. Double-lumen tube / bronchial blocker
6. Cardiac anesthesia
7. TEE
8. Regional anesthesia
9. Pain medicine
10. Research / abstract / poster
11. AI in anesthesia
12. Quality improvement
13. Critical care

### 10.4 推薦邏輯 MVP

第一版可手動標記推薦程度：

- Must attend
- Interested
- Backup

第二版可加入關鍵字自動推薦。

關鍵字範例：

```text
airway, difficult airway, thoracic, one-lung ventilation, OLV, double-lumen tube, DLT, bronchial blocker, cardiac anesthesia, TEE, transesophageal echocardiography, regional anesthesia, pain, quality improvement, artificial intelligence, AI, research, poster
```

若 session title 或 description 包含以上關鍵字，系統可自動標記為 recommended candidate。

### 10.5 My ASA Schedule

使用者可將會議項目加入自己的每日行程。

按鈕：

```text
Add to My ASA Schedule
```

加入後，該課程應同時出現在：

- Conference 頁面
- Daily itinerary
- Dashboard 的 Today at ASA

### 10.6 時間衝突提醒

若加入兩個時間重疊的會議項目，系統提醒：

```text
Time conflict detected
```

顯示：

- Session A
- Session B
- 重疊時間

可選：

- Keep both
- Choose one
- Mark one as backup

### 10.7 場地 / 房間索引

新增 Venue / Room Index。

欄位：

| 欄位 | 說明 |
|---|---|
| venueName | 場地名稱 |
| roomName | 房間名稱 |
| floor | 樓層 |
| area | 區域 |
| purpose | poster / lecture / registration / exhibit / food / other |
| mapImage | 會場地圖圖片，可選 |
| externalMapUrl | 官方會場圖連結，可選 |
| notes | 導航備註 |

### 10.8 Poster presentation panel

因使用者有 ASA poster，需有獨立區塊。

欄位：

| 欄位 | 內容 |
|---|---|
| posterTitle | From Awake Intubation to Lung Isolation: AEC-Guided DLT Exchange in a Post-Oncologic Difficult Airway with Tracheal Bronchus |
| meeting | ASA San Diego 2026 |
| session | MCC / QI poster session, pending official notification |
| date | pending |
| time | pending |
| posterNumber | pending |
| location | pending |
| uploadDeadline | pending |
| checkInRequirement | pending |
| notes | 服裝、名片、與 VS 約定、poster QR code |

### 10.9 Session Notes

每個 ASA session 可新增筆記。

欄位：

| 欄位 | 說明 |
|---|---|
| sessionId | 對應會議項目 |
| notes | 筆記內容 |
| keyPoints | 重點條列 |
| references | 提到的 guideline / paper |
| actionItems | 回國後要做的事 |
| tags | 標籤 |

### 10.10 會後匯出

支援匯出：

- ASA learning notes Markdown
- Conference schedule CSV
- Expense report CSV / Excel
- Full trip summary PDF

Markdown 匯出範例：

```md
# ASA San Diego 2026 Learning Notes

## Airway Sessions

### Session title
- Key point 1
- Key point 2
- Clinical relevance

## Cardiac / TEE Sessions

...
```

---

## 11. Dashboard 設計

Dashboard 是首頁，應顯示最重要資訊。

### 11.1 區塊

1. Today’s itinerary
2. Next destination
3. Today at ASA
4. Next conference item
5. Current balance
6. Quick add
7. Hotel today
8. Important reminders

### 11.2 範例

```text
ASA San Diego 2026

Today｜Oct 17
Hotel: Embassy Suites by Hilton San Diego Bay Downtown

Next Trip Item:
12:30 Lunch near Convention Center

Today at ASA:
08:00 Airway session, Room __
14:00 Poster viewing, Hall __

Current Balance:
You owe Companion: USD ___

Quick Add:
+ Itinerary
+ Expense
+ Conference Session
+ Booking
+ Note
```

---

## 12. 權限與分享

### 12.1 MVP 權限

WeTravel-App 採用分享連結共同編輯模式。

使用原則：

- 不公開分享連結
- 只傳給信任的旅伴
- 兩人皆可新增與編輯資料

### 12.2 建議權限

| 動作 | 我 | 旅伴 |
|---|---|---|
| 查看行程 | 可以 | 可以 |
| 新增行程 | 可以 | 可以 |
| 編輯行程 | 可以 | 可以 |
| 新增支出 | 可以 | 可以 |
| 編輯自己的支出 | 可以 | 可以 |
| 刪除對方支出 | 建議限制 | 建議限制 |
| 修改整趟旅程設定 | 可以 | 可限制 |

---

## 13. MVP 開發階段

### Phase 0：原始專案上線

目標：讓 WeTravel-App 在自己的 GitHub Pages 正常運作。

任務：

1. Fork repo
2. 建立 Firebase project
3. 啟用 Anonymous Auth
4. 建立 Firestore Database
5. 貼上 firestore.rules
6. 修改 firebase-config.js
7. 開啟 GitHub Pages
8. 手機測試 PWA
9. 分享連結給旅伴測試共編

### Phase 1：輸入 ASA trip 資料

任務：

1. 建立 ASA San Diego 2026 旅程
2. 新增兩位成員
3. 新增航班資訊
4. 新增三間飯店
5. 新增每日初步行程
6. 新增已知飯店費用
7. 測試分帳結果

### Phase 2：輕量客製 ASA 功能

任務：

1. 行程類型新增 conference
2. 行程類型新增 poster
3. Dashboard 顯示 Today at ASA
4. 新增 My Presentation 固定區塊
5. Wishlist 支援 conference item
6. ASA sessions 可加入每日 itinerary

### Phase 3：完整 ASA Conference Assistant

任務：

1. 新增 Conference tab
2. 新增 recommended sessions
3. 新增 venue / room index
4. 新增 conflict detection
5. 新增 session notes
6. 新增 Markdown export

### Phase 4：進階旅行功能

任務：

1. 收據上傳
2. 匯出 Excel / PDF
3. Tip calculator
4. Google Places API autocomplete
5. 更完整的 Google Maps route
6. 更改 UI / icon / PWA 素材

---

## 14. 不做或延後的功能

### 14.1 不做

- 餐廳投票
- 天氣預報
- 穿著建議

### 14.2 延後

- 完整會員系統
- 複雜權限管理
- 多旅程 SaaS
- 付款串接
- AI 自動排程
- 自動同步官方 ASA agenda

---

## 15. 建議資料輸入順序

上線後先依序輸入：

1. 旅程名稱：ASA San Diego 2026
2. 成員：我、同伴
3. 航班
4. 三間飯店
5. 10/14–10/21 每日行程
6. 飯店費用
7. 已知訂位 / booking number
8. ASA poster 資訊
9. ASA 官方議程公布後，再加入推薦課程
10. 最後測試分帳與手機使用

---

## 16. 給 Claude / Codex 的客製化 Prompt

若要請 AI 幫忙修改 fork 後的 WeTravel-App，可使用以下 prompt：

```text
You are editing my fork of benson5566/WeTravel-App.

Goal:
Customize this app for my ASA San Diego 2026 trip. Keep the original Firebase + GitHub Pages architecture. Do not rewrite the project into Next.js.

Please implement the following changes carefully in small steps:

1. Add a new itinerary item type: conference.
2. Add a new itinerary item type: poster.
3. Add ASA-related categories to wishlist items.
4. Add a dashboard section called "Today at ASA" that shows today's conference and poster itinerary items.
5. Add a fixed "My Presentation" panel with editable fields:
   - poster title
   - session date/time
   - poster number
   - location
   - upload deadline
   - check-in requirement
   - notes
6. Add a simple conference session data structure that can store:
   - date
   - start time
   - end time
   - title
   - session type
   - topic category
   - location
   - speaker
   - priority
   - notes
   - status
7. Do not add restaurant voting.
8. Do not add weather or outfit notes.
9. Preserve existing travel planning, expense tracking, split calculation, PWA, and Firebase sync features.
10. Make changes mobile-friendly.

Please first inspect the existing file structure and explain which files need to be modified before making changes.
```

---

## 17. 成功標準

第一版成功的標準：

- 網站可在 GitHub Pages 開啟
- 手機可加入主畫面
- 我與同伴可用同一個連結共編
- 可新增每日行程
- 可新增餐廳、景點、飯店、交通
- 可記帳
- 可自動計算誰欠誰
- 可把 ASA session 當作 conference item 加入行程
- Dashboard 看得到今日行程與今日 ASA 相關事項
- Poster presentation 資訊可集中管理

---

## 18. 最終產品定位

本網站最終定位為：

> A shared ASA travel and conference companion for two-person travel.

它應該同時回答：

1. 今天要去哪裡？
2. 下一個地點在哪裡？
3. 今天 ASA 有什麼重要課程？
4. 我的 poster 什麼時候報告？
5. 哪些課程值得聽？
6. 會議室在哪裡？
7. 這趟目前花了多少錢？
8. 誰欠誰多少錢？
9. 回國後有什麼會議筆記可以整理？

---

## 19. 開始部署 checklist

### GitHub

- [ ] 已 fork `benson5566/WeTravel-App`
- [ ] repo 名稱確認
- [ ] 確認在自己的 GitHub 帳號底下

### Firebase

- [ ] 建立 Firebase project
- [ ] 關閉 Google Analytics
- [ ] 啟用 Anonymous Auth
- [ ] 建立 Firestore Database
- [ ] 選擇 production mode
- [ ] 地區選 asia-east1
- [ ] 貼上 firestore.rules
- [ ] 新增 Web App
- [ ] 取得 firebaseConfig

### GitHub repo 設定

- [ ] 修改 `firebase-config.js`
- [ ] Commit changes
- [ ] Settings → Pages
- [ ] Source: Deploy from branch
- [ ] Branch: main
- [ ] Folder: root
- [ ] Save
- [ ] 等待 GitHub Pages 部署完成

### 測試

- [ ] 網址可開啟
- [ ] 手機可開啟
- [ ] 可建立旅程
- [ ] 可新增行程
- [ ] 可新增支出
- [ ] 分帳正確
- [ ] 分享連結給同伴可共編

---

## 20. 備註

本 PRD 以快速可用為優先，不以完美架構為優先。  
若這趟 ASA 使用後確認需求穩定，未來可考慮重寫為：

- Next.js
- Supabase
- Vercel
- Google Places API
- 更完整的會員與權限系統

但目前最務實的策略是：

> 先用 WeTravel-App 快速上線，完成 ASA 2026 實際可用版本。
