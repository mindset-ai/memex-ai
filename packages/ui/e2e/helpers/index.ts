// Barrel for the rebuilt e2e foundation (spec-172). Journey authors import the
// `test`/`expect` fixtures and URL helpers from here, plus any seed helpers.

export {
  test,
  expect,
  tenantPath,
  bareUrl,
  switchToEditing,
  sendChat,
  DEV_EMAIL,
  DEV_NAME,
  type TestResources,
} from "./fixtures.js";

export {
  getPersonalMemexByEmail,
  ensureUser,
  setUserName,
  clearUserName,
  seedSpecInMemex,
  deleteDoc,
  clearOrgMemberships,
  cleanup,
  markEmailVerified,
  seedOrg,
  addOrgMember,
  addOrgDomain,
  createInvite,
  createDomainVerification,
  verifyDomain,
  resolveMemexId,
  seedOpenDecision,
  seedAc,
  seedIssue,
  seedTestEvent,
  signupWithToken,
  type PersonalMemex,
  type SeededOrg,
} from "./seed.js";

export { emitAcEvents } from "./emit-ac.js";
