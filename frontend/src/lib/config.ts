export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL as string,
  cognito: {
    region: (import.meta.env.VITE_COGNITO_REGION as string) || "eu-west-2",
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID as string,
    userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID as string,
    domain: import.meta.env.VITE_COGNITO_DOMAIN as string,
    redirectSignIn: import.meta.env.VITE_COGNITO_REDIRECT_SIGN_IN as string,
    redirectSignOut: import.meta.env.VITE_COGNITO_REDIRECT_SIGN_OUT as string,
  },
};

export function assertConfig() {
  if (!config.apiBaseUrl) throw new Error("VITE_API_BASE_URL is required");
  if (!config.cognito.userPoolId) throw new Error("VITE_COGNITO_USER_POOL_ID is required");
  if (!config.cognito.userPoolClientId) throw new Error("VITE_COGNITO_USER_POOL_CLIENT_ID is required");
  if (!config.cognito.domain) throw new Error("VITE_COGNITO_DOMAIN is required");
}
