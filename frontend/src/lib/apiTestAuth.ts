import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signInWithRedirect, signOut } from "aws-amplify/auth";
import "aws-amplify/auth/enable-oauth-listener";

import { config } from "./config";

function currentPageUrl(): string {
  const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return new URL(`${basePath}/api-test.html`, window.location.origin).href;
}

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: config.cognito.userPoolId,
      userPoolClientId: config.cognito.userPoolClientId,
      loginWith: {
        oauth: {
          domain: config.cognito.domain,
          scopes: ["openid", "email", "profile"],
          redirectSignIn: [currentPageUrl()],
          redirectSignOut: [currentPageUrl()],
          responseType: "code",
        },
      },
    },
  },
});

export async function apiTestCurrentUser() {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

export async function apiTestGetIdToken(): Promise<string | null> {
  const session = await fetchAuthSession();
  return session.tokens?.idToken?.toString() ?? null;
}

export async function apiTestLogin() {
  await signInWithRedirect();
}

export async function apiTestLogout() {
  await signOut();
}
