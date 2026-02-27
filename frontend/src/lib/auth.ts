import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signInWithRedirect, signOut } from "aws-amplify/auth";
import "aws-amplify/auth/enable-oauth-listener";

import { config } from "./config";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: config.cognito.userPoolId,
      userPoolClientId: config.cognito.userPoolClientId,
      loginWith: {
        oauth: {
          domain: config.cognito.domain,
          scopes: ["openid", "email", "profile"],
          redirectSignIn: [config.cognito.redirectSignIn],
          redirectSignOut: [config.cognito.redirectSignOut],
          responseType: "code",
        },
      },
    },
  },
});

export async function currentUser() {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

export async function getIdToken(): Promise<string | null> {
  const session = await fetchAuthSession();
  return session.tokens?.idToken?.toString() ?? null;
}

export async function login() {
  await signInWithRedirect();
}

export async function logout() {
  await signOut();
}
