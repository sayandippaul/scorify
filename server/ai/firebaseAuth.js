import { createRemoteJWKSet, jwtVerify } from "jose";

const firebaseKeys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

export const verifyFirebaseIdToken = async (authorization) => {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!projectId || !token || token.length > 8192) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, firebaseKeys, {
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      algorithms: ["RS256"],
    });

    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 128 ||
      !Number.isFinite(payload.auth_time) ||
      payload.auth_time > Math.floor(Date.now() / 1000) + 300
    ) {
      return null;
    }

    return { uid: payload.sub, projectId, token };
  } catch {
    return null;
  }
};
