const { autorun } = require(".");

module.exports = obs => {
  let val;
  const cancel = autorun(() => {
    val = obs();
  });
  cancel();
  return val;
};
