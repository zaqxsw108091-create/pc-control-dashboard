// 위험 알림: 조회 기록을 훑어서 "주의"가 새로 생기거나 사라진 때를 찾습니다.
// 기준을 넘었다는 알림일 뿐 침해(공격)를 판정하는 것이 아닙니다. 값을 읽기만 합니다.
export function computeAlerts(entries = [], { maxEvents = 30 } = {}) {
  const prev = new Map();
  const since = new Map();
  const events = [];
  for (const e of entries) {
    for (const i of e.items || []) {
      if (i.status === 'unknown') continue; // 읽지 못한 값은 상태가 바뀐 것으로 보지 않아요
      const wasWarn = prev.get(i.id) === 'warn';
      const isWarn = i.status === 'warn';
      if (isWarn && !wasWarn) {
        events.push({ at: e.at, id: i.id, label: i.label, kind: 'start', text: i.text });
        since.set(i.id, e.at);
      } else if (!isWarn && wasWarn) {
        events.push({ at: e.at, id: i.id, label: i.label, kind: 'resolved', text: i.text });
        since.delete(i.id);
      }
      prev.set(i.id, i.status);
    }
  }
  const last = entries[entries.length - 1];
  const current = last
    ? (last.items || [])
        .filter((i) => i.status === 'warn')
        .map((i) => ({ id: i.id, label: i.label, text: i.text, hint: i.hint, since: since.get(i.id) || last.at }))
    : [];
  return { current, events: events.slice(-maxEvents).reverse(), checkedAt: last ? last.at : null };
}
