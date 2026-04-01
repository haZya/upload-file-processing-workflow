import type { APIGatewayAuthorizerWithContextResult, APIGatewayRequestAuthorizerEvent, Handler } from "aws-lambda";

import { Effect } from "aws-cdk-lib/aws-iam";

export interface AuthorizerResultContext {
  userSub?: string;
  [key: string]: string | number | boolean | null | undefined; // Cannot have objects or arrays
}

type AuthorizerResult = APIGatewayAuthorizerWithContextResult<AuthorizerResultContext>;

async function verifyToken(_token: string): Promise<{ sub: string }> {
  // Demo-only mock verification. In production, verify the JWT signature and claims
  // with your identity provider (for example, using CognitoJwtVerifier with your
  // user pool and app client configuration) before trusting and forwarding `sub`.
  return { sub: "demo-user-sub" };
}

export const handler: Handler<APIGatewayRequestAuthorizerEvent, AuthorizerResult> = async (event) => {
  const { methodArn, headers, queryStringParameters } = event;

  const token = headers?.Authorization || queryStringParameters?.token || "";

  // Remove "Bearer " prefix if present
  const cleanToken = token.replace("Bearer ", "");

  try {
    const payload = await verifyToken(cleanToken);

    console.info("Token verification successful");

    // Return 'Allow' policy upon successful verification
    return generatePolicy(payload.sub, Effect.ALLOW, methodArn, { userSub: payload.sub });
  }
  catch (error) {
    // Any verification failure (expired, invalid signature, etc.) triggers Deny
    console.error("Token verification failed:", error);

    return generatePolicy("unauthorized", Effect.DENY, methodArn);
  }
};

function generatePolicy(principalId: string, effect: Effect, resource: string, context: AuthorizerResultContext = {}): AuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context, // Pass the needed values integration lambda
  };
}
