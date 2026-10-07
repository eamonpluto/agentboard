// CrewBus M5 mobile: minimal babel config for the Expo toolchain machine.
// `babel-preset-expo` resolves after `npm install`.
// NOTE: package.json sets `"type": "module"`, so this file MUST stay ESM
// (`export default`) — `module.exports` crashes Metro with
// "module is not defined in ES module scope" during `npx expo export`.
export default function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
}
