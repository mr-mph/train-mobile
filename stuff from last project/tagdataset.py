from huggingface_hub import HfApi

HfApi().create_tag("mr-mph/lerobot-testing", tag="v3.0", repo_type="dataset")
