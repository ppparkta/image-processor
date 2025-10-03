### 실행방법

1. docker 명령어로 리눅스 환경에 맞는 node_modules를 생성합니다.

    ```bash
        docker run --rm \
        --platform=linux/amd64 \
        -v "$PWD":/var/task \
        -w /var/task \
        --entrypoint /bin/bash \
        public.ecr.aws/lambda/nodejs:22 \
        -lc "npm install sharp@0.34.3 @aws-sdk/client-s3 --omit=dev --include=optional && node --input-type=module -e \"import('sharp').then(()=>console.log('sharp OK')).catch(e=>console.error(e))\""
    ```

    - 간혹 의존성 설치가 안 되는 경우가 있습니다. 아래의 명령어를 확인하고 다음 단계를 진행합니다. (선택)

    ```bash
        docker run --rm \
        --platform=linux/amd64 \
        -v "$PWD":/var/task \
        -w /var/task \
        --entrypoint /bin/bash \
        public.ecr.aws/lambda/nodejs:22 \
        -lc "node --input-type=module -e \"import('sharp').then(s=>console.log('sharp version:', s.versions)).catch(e=>console.error(e))\" && ls -1 node_modules/@img | grep sharp || true"
    ```

2. ZIP 파일을 만듭니다.

    ```bash
        zip -r9 lambda-image-processor.zip . -x "*.git*" "*.DS_Store"
    ```

3. ZIP 파일을 AWS Lambda에 업로드합니다.

    ```bash
        aws lambda update-function-code \
        --function-name <함수이름> \
        --zip-file fileb://function.zip
    ```