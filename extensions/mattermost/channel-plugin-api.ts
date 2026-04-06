// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag Mattermost runtime/send/monitor surfaces into lightweight plugin loads.
export { mattermostPlugin } from "./src/channel.js";
