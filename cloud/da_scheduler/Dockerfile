FROM public.ecr.aws/lambda/python:3.12

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY cloud/common/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY cloud ${LAMBDA_TASK_ROOT}/cloud
COPY test_env_backend/global1/utils ${LAMBDA_TASK_ROOT}/utils
COPY test_env_backend/global1/config/constants.py ${LAMBDA_TASK_ROOT}/config/constants.py
COPY test_env_backend/global1/config/sites ${LAMBDA_TASK_ROOT}/config/sites

CMD ["cloud.da_scheduler.handler.lambda_handler"]
