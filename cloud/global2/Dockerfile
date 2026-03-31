FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . ${LAMBDA_TASK_ROOT}

# Default command -> fetch lambda
CMD ["lambda_fetch_handler.lambda_handler"]
