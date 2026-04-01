import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { DomainName, IWebSocketApi, IWebSocketStage, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { AttributeType, ITableV2, StreamViewType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

interface WebSocketStackProps extends StackProps {
    readonly customDomain?: string
    readonly certificate?: ICertificate;
}

export class WebSocketStack extends Stack {
    public readonly connectionsTable: ITableV2;
    public readonly api: IWebSocketApi;
    public readonly stage: IWebSocketStage;

    constructor(scope: Construct, id: string, props: WebSocketStackProps) {
        super(scope, id, props);

        const { customDomain, certificate } = props

        // Ensure on-demand capacity is enabled (recommended for variable load like WebSockets)
        // If you need provisioned capacity, you would set 'billing' mode explicitly.
        // By default, TableV2 uses PAY_PER_REQUEST, which is ideal here.
        const connectionsTable = new TableV2(this, "WebSocketConnectionsTable", {
            partitionKey: { name: "PK", type: AttributeType.STRING },
            sortKey: { name: "SK", type: AttributeType.STRING }, // Define the Sort Key (SK) to create the one-to-many relationship
            timeToLiveAttribute: "ttl",
            removalPolicy: RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
        });

        const authHandler = new NodejsFunction(this, "WebSocketAuthHandler", {
            entry: "lambda/websocket/authorizer.ts",
            runtime: Runtime.NODEJS_22_X,
        });

        const webSocketHandler = new NodejsFunction(this, "WebSocketHandler", {
            entry: "lambda/websocket/connection.ts",
            runtime: Runtime.NODEJS_22_X,
            environment: {
                CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
            },
        });

        connectionsTable.grantReadWriteData(webSocketHandler);
        this.connectionsTable = connectionsTable;

        const webSocketApi = new WebSocketApi(this, "WebSocketApi", {
            connectRouteOptions: {
                integration: new WebSocketLambdaIntegration("ConnectIntegration", webSocketHandler),
                authorizer: new WebSocketLambdaAuthorizer("WebSocketAuthorizer", authHandler),
            },
            disconnectRouteOptions: {
                integration: new WebSocketLambdaIntegration("DisconnectIntegration", webSocketHandler),
            },
            defaultRouteOptions: {
                integration: new WebSocketLambdaIntegration("DefaultIntegration", webSocketHandler),
            },
        });

        webSocketApi.addRoute("message", {
            integration: new WebSocketLambdaIntegration("MessageIntegration", webSocketHandler),
        });

        webSocketApi.grantManageConnections(webSocketHandler);
        this.api = webSocketApi;

        this.stage = new WebSocketStage(this, "ProductionStage", {
            webSocketApi,
            stageName: "prod",
            autoDeploy: true,
            domainMapping: customDomain && certificate
                ? { domainName: new DomainName(this, "WebSocketDomain", { domainName: customDomain, certificate }) }
                : undefined,
        });
    }
}