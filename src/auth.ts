import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import {
  CognitoIdentityClient,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import {
  REGION,
  USER_POOL_ID,
  USER_POOL_CLIENT_ID,
  IDENTITY_POOL_ID,
} from "./config.ts";

export interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const pool = new CognitoUserPool({
    UserPoolId: USER_POOL_ID,
    ClientId: USER_POOL_CLIENT_ID,
  });
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });

  const session: CognitoUserSession = await new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: resolve,
      onFailure: reject,
      newPasswordRequired: () =>
        reject(new Error("Cognito requires a new password — log into the app first to set one.")),
    });
  });

  return {
    idToken: session.getIdToken().getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
    email,
  };
}

/**
 * Exchange a Cognito User Pool JWT for short-lived AWS IAM credentials
 * via the Cognito Identity Pool. The returned provider auto-refreshes.
 */
export function awsCredentialsFromSession(session: Session) {
  // Use `clientConfig` instead of `client` to avoid the type-incompat between
  // the standalone CognitoIdentityClient pkg and the nested copy that
  // credential-provider-cognito-identity expects internally.
  return fromCognitoIdentityPool({
    clientConfig: { region: REGION },
    identityPoolId: IDENTITY_POOL_ID,
    logins: {
      [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: session.idToken,
    },
  });
}

/** One-shot convenience: env → session → AWS creds + Cognito IdentityId. */
export async function loginFromEnv() {
  const email = process.env.HABITAT_EMAIL;
  const password = process.env.HABITAT_PASSWORD;
  if (!email || !password) {
    throw new Error("Set HABITAT_EMAIL and HABITAT_PASSWORD in .env");
  }
  const session = await signIn(email, password);
  const credentialsProvider = awsCredentialsFromSession(session);
  // Resolve once so we surface auth errors early
  const creds: AwsCredentialIdentity = await credentialsProvider();
  const identityId = await getIdentityId(session);
  return { session, credentialsProvider, creds, identityId };
}

/** Get the user's Cognito IdentityId — used as the DynamoDB partition key. */
async function getIdentityId(session: Session): Promise<string> {
  const client = new CognitoIdentityClient({ region: REGION });
  const resp = await client.send(
    new GetIdCommand({
      IdentityPoolId: IDENTITY_POOL_ID,
      Logins: {
        [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: session.idToken,
      },
    }),
  );
  if (!resp.IdentityId) throw new Error("No IdentityId returned from Cognito");
  return resp.IdentityId;
}
