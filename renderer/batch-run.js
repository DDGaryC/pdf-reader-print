// The logic of a batch print, without any screen. Each file goes out only after the
// previous one has finished, which is what keeps the printout in list order.

// A file that cannot be printed is skipped and the rest carry on. Cancelling the Save As
// window stops the batch, because otherwise the next window would pop up straight away
// and the user could never reach the stop button. Sumatra's exit code cannot tell a
// cancel from a failure on those printers, so both count as a cancel there.
export async function runBatch(items, { print, shouldStop, stopOnCancel, onStart }) {
  const total = items.filter((item) => !item.problem).length;
  const outcomes = new Map();
  let stopped = null;
  let position = 0;
  for (const item of items) {
    if (item.problem) {
      outcomes.set(item, { status: 'skipped' });
      continue;
    }
    if (!stopped && shouldStop()) stopped = 'user';
    if (stopped) {
      outcomes.set(item, { status: 'waiting' });
      continue;
    }
    position++;
    onStart(item, position, total);
    const result = await print(item).catch(() => ({ ok: false, reason: 'ERROR' }));
    if (result.ok) {
      outcomes.set(item, { status: 'sent', fellBack: result.fellBackToCounterclockwise === true });
    } else if (stopOnCancel && result.reason === 'PRINT_FAILED') {
      outcomes.set(item, { status: 'canceled' });
      stopped = 'canceled';
    } else {
      outcomes.set(item, { status: 'failed', reason: result.reason });
    }
  }
  return { outcomes, stopped };
}

export function batchMessage({ outcomes, stopped }) {
  const all = [...outcomes.values()];
  const count = (status) => all.filter((outcome) => outcome.status === status).length;
  const sent = count('sent');
  const left = count('waiting') + count('failed') + count('canceled');
  const fellBack = all.filter((outcome) => outcome.fellBack).length;
  let text;
  if (stopped === 'user') {
    text = `已停止。已送出 ${sent} 個檔案，還有 ${left} 個沒有印，按「全部列印」可接著印。`;
  } else if (stopped === 'canceled') {
    text = `已取消存檔，批次先停在這裡。已完成 ${sent} 個檔案，還有 ${left} 個沒有印，按「全部列印」可接著印。`;
  } else if (sent === all.length) {
    text = `已送出 ${sent} 個檔案到印表機。`;
  } else {
    text = `已送出 ${sent} 個檔案，${all.length - sent} 個沒有印出，原因列在清單上。`;
  }
  if (fellBack > 0) text += `其中 ${fellBack} 個無法改成順時針，已用逆時針列印。`;
  return text;
}

// paper is given only with several pages per sheet: { perSheet, merged, sheets, twoSided, perCopy },
// where merged counts the files laid out several to a sheet and sheets is the paper they all take.
export function batchSummary(items, paper = null) {
  if (items.length === 0) return '還沒有加入檔案';
  const checking = items.filter((item) => item.state === 'checking').length;
  if (checking > 0) return `正在檢查檔案，還剩 ${checking} 個…`;
  const good = items.filter((item) => !item.problem);
  const bad = items.length - good.length;
  if (good.length === 0) return `${bad} 個檔案都不能印`;
  const pages = good.reduce((sum, item) => sum + item.pages, 0);
  const others = bad > 0 ? `；另有 ${bad} 個不能印` : '';
  if (paper) {
    const how = paper.merged > 0
      ? `${paper.merged} 個多頁檔案每張紙印 ${paper.perSheet} 頁`
      : '都只有 1 頁，不用合併';
    const sides = paper.twoSided ? '，雙面印' : '';
    return `共 ${good.length} 個檔案、${pages} 頁，${how}${sides}，${paper.perCopy ? '每份' : ''}要用 ${paper.sheets} 張紙${others}`;
  }
  const landscape = good.reduce((sum, item) => sum + item.landscape, 0);
  const turned = landscape > 0 ? `其中 ${landscape} 頁橫向已自動轉向` : '沒有橫向頁';
  return `共 ${good.length} 個檔案、${pages} 頁，${turned}${others}`;
}
