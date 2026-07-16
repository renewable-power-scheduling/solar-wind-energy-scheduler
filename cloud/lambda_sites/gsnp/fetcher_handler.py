from cloud.fetcher_core.fetcher_engine import run


def lambda_handler(event, context):
    return run("GSNP", event, context)