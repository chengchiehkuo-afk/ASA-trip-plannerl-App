import assert from 'node:assert/strict';
import { CHECKLIST_CATEGORIES, LUGGAGE_META, CHECKLIST_TEMPLATE } from '../checklist-data.js';

const slugs = CHECKLIST_CATEGORIES.map(c => c.slug);
assert.equal(CHECKLIST_CATEGORIES.length, 8, '分類必須 8 類');
assert.deepEqual(slugs, ['docs', 'tech', 'meds', 'toiletry', 'makeup', 'clothes', 'flight', 'misc'], '分類順序照 spec');
assert.deepEqual(Object.keys(LUGGAGE_META), ['carry', 'any', 'checked', 'na'], '行李位置三態 + 不適用（給不涉及行李的待辦項目用）');

assert.equal(CHECKLIST_TEMPLATE.length, 75, '模板必須 75 項');
const byCat = {};
for (const t of CHECKLIST_TEMPLATE) {
    assert.ok(slugs.includes(t.category), `未知分類: ${t.category} (${t.name})`);
    assert.ok(['carry', 'any', 'checked'].includes(t.luggage), `未知行李位置: ${t.luggage} (${t.name})`);
    assert.ok(t.name && typeof t.name === 'string', '項目名稱必填');
    assert.equal(typeof t.note, 'string', `note 必須是字串 (${t.name})`);
    assert.ok(!('id' in t) && !('checkedBy' in t), '模板不含 id/checkedBy，seed 時才補');
    byCat[t.category] = (byCat[t.category] || 0) + 1;
}
assert.deepEqual(byCat, { docs: 10, tech: 11, meds: 7, toiletry: 21, makeup: 9, clothes: 10, flight: 3, misc: 4 }, '各分類項數照 spec 附錄A');
console.log('checklist-data.test.mjs: all assertions passed ✓');
