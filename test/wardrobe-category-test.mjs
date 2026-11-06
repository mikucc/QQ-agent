// 衣柜场合判定测试：默认在家，只有地点明确不是家才算出门
import assert from 'node:assert/strict';
import { renderSchedule } from '../plugins/daily-schedule/prompt.js';
import { compose } from '../plugins/image-studio/compose.js';

const wardrobe = {
  outside: '外出卫衣', home: '居家运动', sleep: '睡衣丝质',
  hairOutside: '披散', hairHome: '夹起', hairSleep: '松低马尾'
};

function dayWith(activity, location, start = '12:00', end = '13:00') {
  return {
    date: '2026-11-05', dayType: 'overtime', wardrobe,
    segments: [
      { start: '00:00', end: start, activity: '睡觉', location: '家 卧室', with: '', note: '' },
      { start, end, activity, location, with: '', note: '' }
    ]
  };
}

const at = (h, m) => ({ date: '2026-11-05', weekday: 3, hour: h, minute: m });

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('地点=外面、活动=食堂吃午饭 → 出门装', () => {
  const t = renderSchedule(dayWith('在食堂吃午饭，然后自己逛教学楼和图书馆', '外面'), at(12, 30), {});
  assert.ok(t.includes('穿着「外出卫衣」'), t);
});

ok('地点=火车上 → 出门装', () => {
  const t = renderSchedule(dayWith('坐返程火车', '火车上'), at(12, 30), {});
  assert.ok(t.includes('穿着「外出卫衣」'));
});

ok('地点=家 客厅 → 居家装', () => {
  const t = renderSchedule(dayWith('窝在沙发上看番', '家 客厅'), at(12, 30), {});
  assert.ok(t.includes('穿着「居家运动」'));
});

ok('活动=睡觉 → 睡衣', () => {
  const t = renderSchedule(dayWith('睡觉', '家 卧室'), at(12, 30), {});
  assert.ok(t.includes('穿着「睡衣丝质」'));
});

ok('没写地点 → 默认在家', () => {
  const t = renderSchedule(dayWith('发呆', ''), at(12, 30), {});
  assert.ok(t.includes('穿着「居家运动」'));
});

const stubLib = {
  characters: [],
  outfits: ['外出卫衣', '居家运动', '睡衣丝质'].map((name) => ({
    category: 'outfits', id: name, name, aliases: [], description: `${name}描述`, traits: '', images: []
  })),
  scenes: [],
  props: []
};

ok('compose：日程地点=外面 → 选出门装', () => {
  const c = compose({ prompt: '在车站拍照', wardrobe, scheduleActivity: '在食堂吃午饭', scheduleLocation: '外面' }, {}, stubLib);
  assert.equal(c.selected.outfits.map((o) => o.name).join(','), '外出卫衣');
});

ok('compose：日程地点=家 → 选居家装', () => {
  const c = compose({ prompt: '在沙发上看番', wardrobe, scheduleActivity: '窝在沙发上看番', scheduleLocation: '家 客厅' }, {}, stubLib);
  assert.equal(c.selected.outfits.map((o) => o.name).join(','), '居家运动');
});

console.log(`\n衣柜场合判定：通过 ${pass}，失败 0`);
