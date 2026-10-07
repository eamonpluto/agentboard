// CrewBus M5 mobile: minimal babel config for the Expo toolchain machine.
// `babel-preset-expo` resolves after `npm install` (deliberately NOT run here).
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
