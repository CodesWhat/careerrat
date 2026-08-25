export const CAREERRAT_APP_NAME = "CareerRat";
export const CAREERRAT_APP_ID = "com.codeswhat.careerrat";
export const CAREERRAT_DEV_APP_ID = `${CAREERRAT_APP_ID}.dev`;

export function configureCareerRatAppIdentity({ app, platform = process.platform } = {}) {
  app.setName(CAREERRAT_APP_NAME);
  app.setAboutPanelOptions({ applicationName: CAREERRAT_APP_NAME });
  if (platform === "win32") app.setAppUserModelId(CAREERRAT_APP_ID);
}
