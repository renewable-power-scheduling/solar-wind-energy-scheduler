---
tags:
  - utility
  - configuration
  - common
module: "[[Common Utilities]]"
feature: "[[Configuration Management]]"
---

# Configuration Loader

## Purpose

This module implements a robust, layered system for loading site-specific configurations. It is responsible for finding, loading, merging, and caching the configuration for any given site.

It follows a clear hierarchy, assembling a single configuration object from multiple sources. This design separates general configuration from sensitive credentials and allows for dynamic overrides, making the system flexible and secure.

## File Location

```
d:\Vedanjay Power\Codes Deployed on cloud\Test Environment Code\Github code\solar-wind-energy-scheduler-test-env\cloud\common\config_loader.py
```

## Configuration Hierarchy

The loader assembles the final configuration for a site using the following layered approach, where later layers can override earlier ones:

1.  **Base JSON Config**: The primary, non-sensitive configuration is loaded from a JSON file in `cloud/configs/sites/`. (e.g., `ANJANGOAN.json`). This file is intended to be committed to version control.
2.  **Credential YAML File**: Sensitive data (like FTP passwords) is loaded from a YAML file in `cloud/configs/credentials/`. (e.g., `anjangoan_ftp_credentials.yaml`). These files should be excluded from version control (e.g., via `.gitignore`).
3.  **Environment Variables**: Specific values can be overridden at runtime by setting environment variables (e.g., `SITE_PASSWORD`). This is the highest level of precedence and is useful for CI/CD pipelines and local testing.

## Functions

### `load_site_config(site_id: str) -> dict`

This is the main public function of the module and the primary entry point for the rest of the application to get configuration.

-   **Caching**: The function is decorated with `@lru_cache(maxsize=None)`. This means that after a configuration for a specific site is loaded for the first time, the result is cached in memory. All subsequent calls to `load_site_config` for the same site will return the cached result instantly, avoiding redundant and slow file I/O.
-   **Orchestration**: It performs the following steps:
    1.  Normalizes the `site_id` (e.g., "anjangaon" -> "ANJANGOAN").
    2.  Loads the base JSON configuration file.
    3.  Loads the corresponding credential YAML file.
    4.  Merges the credentials (e.g., FTP username/password) into the configuration object.
    5.  Applies any final overrides from environment variables.
-   **Returns**: A single, comprehensive dictionary containing the complete configuration for the requested site.

### `list_site_ids() -> list[str]`

A utility function that scans the `cloud/configs/sites/` directory and returns a sorted list of all available site IDs based on the JSON filenames found there.

### Helper Functions

-   `normalize_site_id(site_id: str)`: Cleans up a site ID by trimming whitespace, converting to uppercase, and applying any defined aliases from the `SITE_ID_ALIASES` dictionary.
-   `_load_json(path: Path)`: A private helper to load and parse a JSON file.
-   `_load_credentials(site_token: str)`: A private helper that finds and loads a site's credential YAML file. It requires the `pyyaml` library.
-   `_apply_env_overrides(cfg: dict)`: A private helper that checks for specific environment variables and updates the configuration dictionary accordingly.

## Environment Variable Overrides

The following environment variables can be used to override configuration values at runtime:

-   `SITE_ID`: Overrides the site ID for the current run.
-   `RUN_ONCE`: If set to `1`, `true`, or `yes`, forces a continuous run to stop after one iteration.
-   `RETRY_SECONDS_ON_ERROR`: Sets the retry delay in seconds.
-   `FETCH_BASE_DIR`: Overrides the base directory for saving fetched data.
-   `SITE_PASSWORD`: Injects a password, typically for an FTP connection.

## Dependencies

-   `pyyaml`: Required for parsing credential YAML files.

## Related Documentation

-   [[Site Configuration]]
-   [[Common Utilities]]
-   [[Configuration Constants]]
