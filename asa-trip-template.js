// ASA San Diego 2026 旅程範本：純資料模組（node 可直接 import 驗證，見 tests/asa-trip-template.test.mjs）
// 這是「選用」範本：只有使用者在開新旅程時明確按下 Use ASA San Diego 2026 Template 才會套用，
// 一般 Blank Trip 流程完全不受影響。改內容改這裡即可，不要在 app.js 裡再散寫。

export const ASA_SD_2026_TRIP_DEFAULTS = {
    destination: 'San Diego, ASA 2026',
    startDate: '2026-10-14',
    days: 8,
    currency: 'USD',
    // 標記這趟旅程是套用 ASA 範本建立的，用來決定要不要顯示「議程」這個 ASA 專屬分頁——
    // 一般（空白行程）不會有這個欄位，讀回來是 undefined/false，就不會顯示。
    isAsaTemplate: true,
};

// [date(YYYY-MM-DD), time(HH:MM), type, activity, note]
// type 對應 app 既有的行程分類：transport / hotel / spot(景點) / food(餐廳) / conference
const I = [
    ['2026-10-14', '12:23', 'transport', 'Arrive at San Diego International Airport (SAN)', 'Arrive in San Diego. Transfer to Empress Hotel La Jolla.'],
    ['2026-10-14', '14:00', 'hotel', 'Check in / luggage drop at Empress Hotel La Jolla', 'Stay 10/14–10/16.'],
    ['2026-10-14', '16:00', 'spot', "La Jolla Cove / Children's Pool / Seal Rock walk", 'Easy arrival-day walk.'],
    ['2026-10-14', '18:30', 'food', 'Dinner in La Jolla', "Candidate restaurants: George's at the Cove, Puesto La Jolla, The Cottage La Jolla."],

    ['2026-10-15', '09:00', 'food', 'Breakfast / coffee in La Jolla', ''],
    ['2026-10-15', '10:00', 'spot', 'La Jolla Cove and Coast Walk Trail', ''],
    ['2026-10-15', '12:00', 'food', 'Lunch in La Jolla', ''],
    ['2026-10-15', '14:00', 'spot', 'Optional afternoon activity', 'Choose one: La Jolla Shores, kayak / sea cave tour, or Birch Aquarium.'],
    ['2026-10-15', '18:30', 'food', 'Dinner in La Jolla', ''],

    ['2026-10-16', '09:00', 'spot', 'Breakfast and final La Jolla walk', ''],
    ['2026-10-16', '11:00', 'hotel', 'Check out from Empress Hotel La Jolla', ''],
    ['2026-10-16', '11:30', 'transport', 'Transfer to Embassy Suites by Hilton San Diego Bay Downtown', ''],
    ['2026-10-16', '13:00', 'hotel', 'Check in / luggage drop at Embassy Suites', 'Stay 10/16–10/20.'],
    ['2026-10-16', '15:00', 'conference', 'ASA registration / badge pickup', 'Confirm exact ASA registration time later.'],
    ['2026-10-16', '17:00', 'spot', 'Seaport Village / waterfront walk', ''],

    ['2026-10-17', '08:00', 'conference', 'ASA meeting day', 'Add selected ASA sessions after official agenda is confirmed.'],
    ['2026-10-17', '18:30', 'food', 'Dinner in Little Italy or Gaslamp Quarter', ''],

    ['2026-10-18', '08:00', 'conference', 'ASA meeting day', 'Add selected ASA sessions after official agenda is confirmed.'],
    ['2026-10-18', '13:30', 'spot', 'USS Midway Museum / Waterfront', 'Flexible half-day plan if conference schedule allows.'],

    ['2026-10-19', '08:00', 'conference', 'ASA meeting day', 'Add selected ASA sessions after official agenda is confirmed.'],
    ['2026-10-19', '14:00', 'spot', 'Balboa Park', 'Choose 1–2 museums or gardens only.'],

    ['2026-10-20', '08:00', 'conference', 'ASA final day', 'Confirm final ASA schedule.'],
    ['2026-10-20', '11:00', 'hotel', 'Check out from Embassy Suites', ''],
    ['2026-10-20', '12:00', 'transport', 'Transfer to Holiday Inn Express San Diego Airport–Old Town', ''],
    ['2026-10-20', '13:00', 'hotel', 'Check in / luggage drop at Holiday Inn Express Airport–Old Town', 'Stay 10/20–10/21.'],
    ['2026-10-20', '15:00', 'spot', 'Old Town State Historic Park', ''],
    ['2026-10-20', '18:00', 'food', 'Dinner in Old Town', 'Candidate restaurants: Cafe Coyote, Casa Guadalajara.'],

    ['2026-10-21', '09:00', 'food', 'Breakfast and pack', ''],
    ['2026-10-21', '11:00', 'hotel', 'Check out and store luggage', ''],
    ['2026-10-21', '11:30', 'spot', 'Old Town half-day walk / lunch / final shopping', ''],
    ['2026-10-21', '15:45', 'transport', 'Return to hotel and pick up luggage', ''],
    ['2026-10-21', '16:15', 'transport', 'Transfer to SAN airport', 'Use hotel shuttle, Uber, or San Diego Flyer from Old Town Transit Center.'],
    ['2026-10-21', '18:51', 'transport', 'Depart from San Diego International Airport (SAN)', ''],
];

export const ASA_SD_2026_ITINERARY = I.map(([date, time, type, activity, note]) => ({ date, time, type, activity, note }));

export const ASA_SD_2026_POSTER = {
    name: 'My Presentation — From Awake Intubation to Lung Isolation: AEC-Guided DLT Exchange in a Post-Oncologic Difficult Airway with Tracheal Bronchus',
    type: 'conference',
    note: 'Poster presentation — ASA San Diego 2026. Date/time: TBD. Location: TBD. Poster number: TBD. Add upload deadline, check-in requirement, and presentation time after ASA notification.',
};

// 航班（多航段）：outbound 掛在 date 那一天的 day.flight，return 同理。
// segments 沒有 id——seed 時（見 app.js 的 seedAsaSanDiego2026Days）才補，跟 checklist/poster 的模板套路一致。
export const ASA_SD_2026_FLIGHTS = {
    outbound: {
        date: '2026-10-14',
        label: '去程',
        segments: [
            { airline: 'EVA Air', flightNumber: 'BR8', departureAirport: 'TPE', arrivalAirport: 'SFO', departureDateTime: '2026-10-14T10:15', arrivalDateTime: '2026-10-14T06:35', departureTerminal: '', arrivalTerminal: '', confirmationNumber: '', notes: '' },
            { airline: 'Alaska Airlines', flightNumber: 'AS740', departureAirport: 'SFO', arrivalAirport: 'SAN', departureDateTime: '2026-10-14T10:40', arrivalDateTime: '2026-10-14T12:23', departureTerminal: '', arrivalTerminal: '', confirmationNumber: '', notes: '' },
        ],
    },
    return: {
        date: '2026-10-21',
        label: '回程',
        segments: [
            { airline: '', flightNumber: '', departureAirport: 'SAN', arrivalAirport: '', departureDateTime: '2026-10-21T18:51', arrivalDateTime: '', departureTerminal: '', arrivalTerminal: '', confirmationNumber: '', notes: 'TBD：回程其餘航班段（轉機／抵達）尚未確認，請自行補上。' },
        ],
    },
};

// 訂位與票券總表（Bookings）用的航班資料：跟上面 ASA_SD_2026_FLIGHTS（掛在 day.flight，itinerary 卡片用）
// 是分開的兩份資料——欄位形狀不同（這裡是分開的 date/time，不是 datetime-local），故意不共用，避免形狀混淆。
// id 沒有先補——seed 時（見 app.js 的 seedAsaSanDiego2026Bookings）才補，跟其他模板套路一致。
export const ASA_SD_2026_BOOKINGS = [
    {
        type: 'flight',
        journeyName: '去程｜Taipei → San Diego',
        confirmationNumber: '',
        bookedBy: '',
        notes: '',
        segments: [
            { airline: 'EVA Air', flightNumber: 'BR8', departureAirport: 'TPE', arrivalAirport: 'SFO', departureDate: '2026-10-14', departureTime: '10:15', arrivalDate: '2026-10-14', arrivalTime: '06:35', departureTerminal: '', arrivalTerminal: '', segmentNotes: '' },
            { airline: 'Alaska Airlines', flightNumber: 'AS740', departureAirport: 'SFO', arrivalAirport: 'SAN', departureDate: '2026-10-14', departureTime: '10:40', arrivalDate: '2026-10-14', arrivalTime: '12:23', departureTerminal: '', arrivalTerminal: '', segmentNotes: '' },
        ],
    },
    {
        type: 'flight',
        journeyName: '回程｜San Diego → Taipei',
        confirmationNumber: '',
        bookedBy: '',
        notes: 'TBD：回程其餘航段（轉機／抵達）尚未確認，請自行補上。',
        segments: [
            { airline: '', flightNumber: '', departureAirport: 'SAN', arrivalAirport: '', departureDate: '2026-10-21', departureTime: '18:51', arrivalDate: '', arrivalTime: '', departureTerminal: '', arrivalTerminal: '', segmentNotes: '' },
        ],
    },
];
