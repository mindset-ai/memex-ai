// Barrel for the rebuilt e2e foundation (spec-172). Journey authors import the
// `test`/`expect` fixtures and URL helpers from here, plus any seed helpers.

export {
  test,
  expect,
  tenantPath,
  bareUrl,
  gotoSpecsBoard,
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
  setIdentityConfirmed,
  clearUserSpecs,
  seedSpecInMemex,
  seedVersionCut,
  deleteDoc,
  clearOrgMemberships,
  cleanup,
  markEmailVerified,
  seedOrg,
  setOrgBilling,
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
  seedEmissionKey,
  seedTask,
  signupWithToken,
  seedAssignee,
  setMemexVisibility,
  setFeaturedDemo,
  seedActivityRow,
  disableMember,
  type PersonalMemex,
  type SeededOrg,
} from "./seed.js";

export { emitAcEvents, installAcEmission } from "./emit-ac.js";
