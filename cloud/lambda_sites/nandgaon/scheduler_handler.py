from cloud.scheduler_core.scheduler_entry import run


def lambda_handler(event, context):
    return run("NANDGAON", event, context)
