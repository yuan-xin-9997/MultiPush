export function parseDouyinVerifyConfig(env: NodeJS.ProcessEnv) {
  const accountId = env.TURBOPUSH_ACCOUNT_ID;
  const expectedTitle = env.TURBOPUSH_EXPECTED_TITLE;
  const expectedBody = env.TURBOPUSH_EXPECTED_BODY;
  if (!accountId || !expectedTitle || expectedBody === undefined)
    throw new Error(
      "只读回验会进入远端草稿；必须显式设置 TURBOPUSH_ACCOUNT_ID、TURBOPUSH_EXPECTED_TITLE 和 TURBOPUSH_EXPECTED_BODY",
    );
  return { accountId, expectedTitle, expectedBody };
}
