export function swapInt(array, index1, index2) {
  const temp = array[index1];
  array[index1] = array[index2];
  array[index2] = temp;
}

export function systemRound(a1) {
  const v1 = Math.floor(a1 + 0.5);
  return v1 !== -Infinity && a1 + 0.5 !== v1 ? v1 - (v1 % 2) : v1;
}
