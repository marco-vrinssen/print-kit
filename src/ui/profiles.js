// Print profiles: two built in, or one ICC file the user loads. The built-in ones are colord's
// CC0 profiles, made with ArgyllCMS from Fogra's characterization data with a 300 % ink limit.
import fogra39 from "./profiles/FOGRA39L_coated.icc";
import fogra47 from "./profiles/FOGRA47L_uncoated.icc";
import { state, request } from "./store.js";
import { t } from "./i18n.js";

export const BUILT_IN = [
  { id: "fogra39", name: "Coated FOGRA39", condition: "FOGRA39", bytes: fogra39 },
  { id: "fogra47", name: "Uncoated FOGRA47", condition: "FOGRA47", bytes: fogra47 },
];

export function profileName(id) {
  if (id === "custom") return state.customProfile ? state.customProfile.name : t("profile.fogra39");
  return t(`profile.${id}`);
}

// The profile the export and the print preview use. A loaded file comes from client storage
// the first time it is needed.
export async function resolveProfile() {
  const id = state.settings.export.profile;
  const builtIn = BUILT_IN.find((p) => p.id === id);
  if (builtIn || !state.customProfile) return builtIn || BUILT_IN[0];
  if (!state.customProfile.bytes) {
    const reply = await request({ type: "load-profile" });
    state.customProfile.bytes = reply.profile ? reply.profile.data : null;
  }
  return state.customProfile.bytes ? { bytes: state.customProfile.bytes, name: state.customProfile.name, condition: null } : BUILT_IN[0];
}

// The color space an ICC file describes, such as "CMYK", or null for a file that isn't one.
export function iccSpace(bytes) {
  if (bytes.length < 40 || String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39]) !== "acsp") return null;
  return String.fromCharCode(bytes[16], bytes[17], bytes[18], bytes[19]).trim();
}
