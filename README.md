### 실행방법

1. docker 명령어로 리눅스 환경에 맞는 node_modules를 생성합니다.

    ```bash
        docker run --rm \
        -v "$PWD":/var/task -w /var/task \
        --entrypoint /bin/bash \
        public.ecr.aws/lambda/nodejs:22 \
        -lc "npm ci"
    ```

2. ZIP 파일을 만듭니다.

    ```bash
        zip -r function.zip index.mjs policy package.json node_modules
    ```

3. ZIP 파일을 AWS Lambda에 업로드합니다.

    ```bash
        aws lambda update-function-code \
        --function-name <함수이름> \
        --zip-file fileb://function.zip
    ```