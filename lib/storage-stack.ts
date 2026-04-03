import type { Construct } from "constructs";

import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
    CachePolicy,
    Distribution,
    SecurityPolicyProtocol,
    ViewerProtocolPolicy
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, IBucket, } from "aws-cdk-lib/aws-s3";

export class StorageStack extends Stack {
    public readonly stagingUploadBucket: IBucket;
    public readonly uploadBucket: IBucket;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        this.stagingUploadBucket = new Bucket(this, "StagingUploadBucket", {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            minimumTLSVersion: 1.2,
            eventBridgeEnabled: true,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    abortIncompleteMultipartUploadAfter: Duration.days(1),
                    expiration: Duration.days(7), // Rule to clean up any orphaned files after 7 days
                },
            ],
        });

        this.uploadBucket = new Bucket(this, "UploadBucket", {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            minimumTLSVersion: 1.2,
            removalPolicy: RemovalPolicy.DESTROY, // Use RETAIN for prod
            autoDeleteObjects: true, // Use false for prod
            lifecycleRules: [
                {
                    abortIncompleteMultipartUploadAfter: Duration.days(1),
                },
            ],
        });

        const cachePolicy = new CachePolicy(this, "UploadBucketCachePolicy", {
            defaultTtl: Duration.days(7),
            minTtl: Duration.seconds(0),
            maxTtl: Duration.days(30),
        });

        new Distribution(this, "UploadBucketDistribution", {
            defaultBehavior: {
                origin: S3BucketOrigin.withOriginAccessControl(this.uploadBucket),
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy,
            },
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_3_2025,
        });
    }
}
