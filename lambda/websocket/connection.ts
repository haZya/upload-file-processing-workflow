import type { APIGatewayEventWebsocketRequestContextV2, APIGatewayProxyWebsocketEventV2WithRequestContext, Handler } from "aws-lambda";

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { AuthorizerResultContext } from "./authorizer";

const client = new DynamoDBClient({});

const db = DynamoDBDocumentClient.from(client);

const tableName = process.env.CONNECTIONS_TABLE_NAME;

const USER_PK_PREFIX = "USER#";
export const CONN_SK_PREFIX = "CONN#";

/**
 * Creates the Partition Key (PK) for the user.
 * @param userId - The ID of the user.
 */
export const getPk = (userId: string) => `${USER_PK_PREFIX}${userId}`;

/**
 * Creates the Sort Key (SK) for the connection.
 * @param connectionId - The unique WebSocket connection ID.
 */
const getSk = (connectionId: string) => `${CONN_SK_PREFIX}${connectionId}`;

const getTtl = () => Math.floor(Date.now() / 1000) + (60 * 60 * 2); // TTL for 2 hours

interface ConnectionItem {
  PK: string; // Partition Key: USER#<userId>
  SK: string; // Sort Key: CONN#<connectionId>
  connectionId: string; // The actual connection ID
  ttl: number; // Unix epoch timestamp (seconds) for expiration for cleanup of stale connections
}

export const handler: Handler<APIGatewayProxyWebsocketEventV2WithRequestContext<APIGatewayEventWebsocketRequestContextV2 & { authorizer: AuthorizerResultContext }>> = async (event) => {
  const { requestContext } = event;
  const { authorizer, connectionId, routeKey } = requestContext;

  const { userSub } = authorizer;

  if (!userSub) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Authorized user not found" }),
    };
  }

  try {
    switch (routeKey) {
      case "$connect":
        await saveConnection(userSub, connectionId);
        return { statusCode: 200 };
      case "$disconnect":
        await removeConnection(userSub, connectionId);
        return { statusCode: 200 };
      case "message":
        // Handle incoming messages from the client.

        // Connection ttl will be updated on every message. Add a condition, if only needed to update on a specific ping message.
        await refreshConnectionTtl(userSub, connectionId);
        return { statusCode: 200 };
      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Invalid action: ${routeKey}` }),
        };
    }
  }
  catch (error: any) {
    // You can inspect the error object here to return specific codes:
    // Example: if (error.message.includes("Validation")) return { statusCode: 400, ... }

    // Default to a 500 for all unexpected internal errors
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message }),
    };
  }
};

/**
 * Saves a new connection ID associated with a user.
 * @param userSub - The authenticated user ID.
 * @param connectionId - The new WebSocket connection ID.
 */
export async function saveConnection(userSub: string, connectionId: string): Promise<void> {
  const item: ConnectionItem = {
    PK: getPk(userSub),
    SK: getSk(connectionId),
    connectionId,
    ttl: getTtl(),
  };

  const command = new PutCommand({
    TableName: tableName,
    Item: item,
  });

  try {
    await db.send(command);
    console.info(`Connection ${connectionId} saved for user ${userSub}`);
  }
  catch (error) {
    console.error("Error saving connection:", error);
    throw new Error("Failed to establish a connection");
  }
}

/**
 * Removes a specific connection ID when the client disconnects.
 * @param userSub - The user ID associated with the connection.
 * @param connectionId - The WebSocket connection ID to remove.
 */
export async function removeConnection(userSub: string, connectionId: string): Promise<void> {
  const command = new DeleteCommand({
    TableName: tableName,
    Key: {
      PK: getPk(userSub),
      SK: getSk(connectionId),
    },
  });

  try {
    await db.send(command);
    console.info(`Connection ${connectionId} removed for user ${userSub}`);
  }
  catch (error) {
    console.error("Error removing connection:", error);
    throw new Error("Failed to remove the connection");
  }
}

/**
 * Refreshes the TTL for an existing connection to keep it alive.
 * Call on a < 10 minutes interval (aws idle timeout), if the connection needs to be kept alive.
 * The timeout could be anywhere between 2-10 minutes specially when using cloudflare, therefore may use to set the interval accordingly (i.e. < 2 minutes)
 * @param userSub - The user ID associated with the connection.
 * @param connectionId - The WebSocket connection ID to refresh.
 */
export async function refreshConnectionTtl(userSub: string, connectionId: string): Promise<void> {
  const command = new UpdateCommand({
    TableName: tableName,
    Key: {
      PK: getPk(userSub),
      SK: getSk(connectionId),
    },
    // Use an ALIAS (#T) for the reserved word 'ttl'
    UpdateExpression: "SET #T = :newTtl",
    // Define the alias mapping
    ExpressionAttributeNames: {
      "#T": "ttl", // #T maps to the actual attribute name 'ttl'
    },
    // Define the value mapping
    ExpressionAttributeValues: {
      ":newTtl": getTtl(),
    },
    // Specifies the attributes to receive in the response after a write operation succeeds
    ReturnValues: "UPDATED_NEW", // Default: NONE
    // Optional: Only update if the item already exists (safety check)
    ConditionExpression: "attribute_exists(PK)",
  });

  try {
    await db.send(command);
    console.info(`TTL refreshed for connection ${connectionId}`);
  }
  catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // This is the expected, non-critical case: TTL deleted the item first. Handle gracefully.
      console.warn(`TTL refresh failed for connection ${connectionId}. Item was likely deleted by TTL service.`, error);
    }
    else {
      // Handle actual critical errors (e.g., Throttling, Access Denied)
      console.error(`Error updating TTL ${connectionId}:`, error);
      throw new Error("Failed to update TTL");
    }
  }
}
