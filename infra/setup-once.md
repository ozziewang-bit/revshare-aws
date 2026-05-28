# One-time AWS resource setup — revshare

Run these steps once, on the machine that owns this repo. Region: ap-northeast-1.
Account: 585546485067.

## 1. DynamoDB table

aws dynamodb create-table \
  --table-name RevsharePartner \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-1

aws dynamodb update-time-to-live \
  --table-name RevsharePartner \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region ap-northeast-1

## 2. SSM password hash

Generate a fresh hash for password `<NEW_PASSWORD>`:

node -e "const {scryptSync,randomBytes}=require('crypto'); const s=randomBytes(16); const h=scryptSync(process.argv[1],s,64); console.log('scrypt\$'+s.toString('hex')+'\$'+h.toString('hex'))" 'NEW_PASSWORD'

Store it:

aws ssm put-parameter --name /revshare/auth-hash \
  --type SecureString --value '<output of above>' \
  --region ap-northeast-1

## 3. Lambda IAM role

aws iam create-role --role-name revshare-api-role \
  --assume-role-policy-document file://infra/trust-lambda.json

aws iam attach-role-policy --role-name revshare-api-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam put-role-policy --role-name revshare-api-role \
  --policy-name revshare-inline --policy-document file://infra/role-policy.json

## 4. Lambda function (initial create)

cd lambda/revshare-api/code && zip -r ../../../_deploy.zip . && cd -

aws lambda create-function --function-name revshare-api \
  --runtime nodejs22.x --handler index.handler \
  --role arn:aws:iam::585546485067:role/revshare-api-role \
  --zip-file fileb://_deploy.zip \
  --timeout 30 --memory-size 256 \
  --environment "Variables={REVSHARE_TABLE=RevsharePartner}" \
  --region ap-northeast-1

rm _deploy.zip

## 5. API Gateway HTTP API

aws apigatewayv2 create-api --name revshare-api --protocol-type HTTP \
  --target arn:aws:lambda:ap-northeast-1:585546485067:function:revshare-api \
  --region ap-northeast-1

aws lambda add-permission --function-name revshare-api \
  --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --region ap-northeast-1

Capture the resulting endpoint URL — used in frontend/app.js.

## 6. S3 bucket + CloudFront

aws s3 mb s3://revshare-frontend-felipetan --region ap-northeast-1

CloudFront distribution + OAC + ACM cert are easier in Console for now; record
the distribution ID and domain back here once provisioned.

## Live IDs (provisioned 2026-05-28)

- DynamoDB table: `RevsharePartner` (ap-northeast-1, on-demand, TTL on `ttl`)
- SSM password hash: `/revshare/auth-hash` (SecureString, scrypt)
- IAM role: `arn:aws:iam::585546485067:role/revshare-api-role`
- Lambda: `revshare-api` (Node 22.x, 256MB, 30s timeout, env `REVSHARE_TABLE=RevsharePartner`)
- API Gateway HTTP API: `mqszkp91di`
- API endpoint URL: `https://mqszkp91di.execute-api.ap-northeast-1.amazonaws.com`
- S3 bucket: `revshare-frontend-felipetan` (static website, public read)
- S3 website URL: `http://revshare-frontend-felipetan.s3-website-ap-northeast-1.amazonaws.com`
- CloudFront distribution ID: not yet provisioned (set `REVSHARE_CLOUDFRONT_DIST_ID` env var when ready)
