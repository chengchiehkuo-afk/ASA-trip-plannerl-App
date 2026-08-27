import assert from 'node:assert/strict';
import { ASA_SD_2026_TRIP_DEFAULTS, ASA_SD_2026_ITINERARY, ASA_SD_2026_POSTER, ASA_SD_2026_FLIGHTS } from '../asa-trip-template.js';

const VALID_TYPES = ['spot', 'food', 'shop', 'transport', 'hotel', 'conference'];

assert.equal(ASA_SD_2026_TRIP_DEFAULTS.destination, 'San Diego, ASA 2026');
assert.equal(ASA_SD_2026_TRIP_DEFAULTS.startDate, '2026-10-14');
assert.equal(ASA_SD_2026_TRIP_DEFAULTS.days, 8);
assert.equal(ASA_SD_2026_TRIP_DEFAULTS.currency, 'USD');

// 8 天：2026-10-14 ~ 2026-10-21
const expectedDates = [];
for (let i = 0; i < ASA_SD_2026_TRIP_DEFAULTS.days; i++) {
    const d = new Date(2026, 9, 14 + i);
    expectedDates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
}
assert.deepEqual(expectedDates, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);

assert.ok(ASA_SD_2026_ITINERARY.length > 0, '固定行程不可為空');
for (const entry of ASA_SD_2026_ITINERARY) {
    assert.ok(expectedDates.includes(entry.date), `行程日期需落在 10/14–10/21 內: ${entry.date}`);
    assert.match(entry.time, /^\d{2}:\d{2}$/, `time 需為 HH:MM: ${entry.time}`);
    assert.ok(VALID_TYPES.includes(entry.type), `未知類型: ${entry.type} (${entry.activity})`);
    assert.ok(entry.activity && typeof entry.activity === 'string', '行程名稱必填');
    assert.equal(typeof entry.note, 'string', `note 必須是字串 (${entry.activity})`);
    assert.ok(!('id' in entry), '模板不含 id，seed 時才補');
}

// 每天至少一項，且同天內時間遞增（避免手誤排序顛倒）
const byDate = {};
ASA_SD_2026_ITINERARY.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
for (const date of expectedDates) {
    assert.ok(byDate[date] && byDate[date].length > 0, `${date} 至少要有一項固定行程`);
    const times = byDate[date].map(e => e.time);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted, `${date} 的行程時間需照時間排序: ${times.join(', ')}`);
}

// 抵達 / 離境航班錨點
assert.ok(byDate['2026-10-14'].some(e => e.time === '12:23' && e.type === 'transport'), '需有 10/14 12:23 抵達 SAN');
assert.ok(byDate['2026-10-21'].some(e => e.time === '18:51' && e.type === 'transport'), '需有 10/21 18:51 離開 SAN');

// Poster placeholder
assert.ok(ASA_SD_2026_POSTER.name.includes('AEC-Guided DLT Exchange'), 'poster 標題需保留關鍵字');
assert.equal(ASA_SD_2026_POSTER.type, 'conference');
assert.ok(ASA_SD_2026_POSTER.note.includes('TBD'), 'poster 備註需標示 TBD 待補資訊');

// 航班（多航段）
const SEGMENT_FIELDS = ['airline', 'flightNumber', 'departureAirport', 'arrivalAirport', 'departureDateTime', 'arrivalDateTime', 'departureTerminal', 'arrivalTerminal', 'confirmationNumber', 'notes'];
for (const journey of [ASA_SD_2026_FLIGHTS.outbound, ASA_SD_2026_FLIGHTS.return]) {
    assert.ok(expectedDates.includes(journey.date), `航段日期需落在 10/14–10/21 內: ${journey.date}`);
    assert.ok(journey.label, '每段航程需要 label（去程/回程）');
    assert.ok(!('id' in journey), '模板不含 id，seed 時才補');
    assert.ok(Array.isArray(journey.segments) && journey.segments.length > 0, `${journey.label} 至少要有一個 flight segment`);
    for (const seg of journey.segments) {
        assert.ok(!('id' in seg), '模板不含 id，seed 時才補');
        for (const field of SEGMENT_FIELDS) {
            assert.ok(field in seg, `segment 缺少欄位 ${field}（${journey.label}）`);
        }
    }
}
assert.equal(ASA_SD_2026_FLIGHTS.outbound.date, '2026-10-14');
assert.equal(ASA_SD_2026_FLIGHTS.outbound.segments.length, 2, '去程目前已知 2 個航班段（BR8, AS740）');
assert.equal(ASA_SD_2026_FLIGHTS.outbound.segments[0].flightNumber, 'BR8');
assert.equal(ASA_SD_2026_FLIGHTS.outbound.segments[0].departureDateTime, '2026-10-14T10:15');
assert.equal(ASA_SD_2026_FLIGHTS.outbound.segments[1].flightNumber, 'AS740');
assert.equal(ASA_SD_2026_FLIGHTS.outbound.segments[1].arrivalDateTime, '2026-10-14T12:23');
assert.equal(ASA_SD_2026_FLIGHTS.return.date, '2026-10-21');
assert.equal(ASA_SD_2026_FLIGHTS.return.segments[0].departureDateTime, '2026-10-21T18:51');
assert.ok(ASA_SD_2026_FLIGHTS.return.segments[0].notes.includes('TBD'), '回程未確認的段落需標示 TBD');

console.log('asa-trip-template.test.mjs: all assertions passed ✓');
