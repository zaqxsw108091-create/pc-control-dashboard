// 한 번만 조회해서 글자로 보여 줍니다. 화면이 이상할 때 원인을 찾는 용도입니다. (읽기만 하고 기록도 남기지 않아요)
//   node student/check-once.mjs          표로 보기
//   node student/check-once.mjs --json   JSON으로 보기
import { collectAll } from './collect.mjs';
import { judgeAll, STATUS_LABEL } from './judge.mjs';

const { items, summary } = judgeAll(await collectAll());
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ platform: process.platform, summary, items }, null, 2));
} else {
  console.log(`운영체제: ${process.platform} · ${summary.text} (주의 ${summary.warn}, 확인 불가 ${summary.unknown})`);
  for (const i of items) {
    console.log(`- [${STATUS_LABEL[i.status]}] ${i.label}: ${i.text}${i.hint ? `\n    ↳ ${i.hint}` : ''}`);
  }
}
