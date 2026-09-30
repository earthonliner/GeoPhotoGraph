/**
 * 批量随机模板：把模板 id 洗牌后依次发放，一轮用完再洗下一轮，
 * 保证 n 张照片在模板数量充足时不会出现重复，且相邻两轮衔接处也尽量不重复。
 */
function shuffle(list, randomFn) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandomTemplates(ids, count, randomFn) {
  const rand = typeof randomFn === 'function' ? randomFn : Math.random;
  const result = [];
  while (result.length < count) {
    const bag = shuffle(ids, rand);
    if (ids.length > 1 && result.length && bag[0] === result[result.length - 1]) {
      bag.push(bag.shift());
    }
    for (const id of bag) {
      if (result.length < count) result.push(id);
    }
  }
  return result;
}

module.exports = { pickRandomTemplates, shuffle };
