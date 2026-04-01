import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, ITableV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";

export class DatabaseStack extends Stack {
    public readonly uploadsTable: ITableV2;
    public readonly uploadRelationsTable: ITableV2;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        this.uploadsTable = new TableV2(this, "UploadsTable", {
            partitionKey: { name: "uploadId", type: AttributeType.STRING },
            removalPolicy: RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            globalSecondaryIndexes: [
                {
                    indexName: "ByRelation",
                    partitionKey: { name: "relationKey", type: AttributeType.STRING },
                    sortKey: { name: "createdAt", type: AttributeType.STRING },
                },
                {
                    indexName: "ByStagingKey",
                    partitionKey: { name: "stagingKey", type: AttributeType.STRING },
                    sortKey: { name: "createdAt", type: AttributeType.STRING },
                },
            ],
        });

        this.uploadRelationsTable = new TableV2(this, "UploadRelationsTable", {
            partitionKey: { name: "relationKey", type: AttributeType.STRING },
            removalPolicy: RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
        });
    }
}
