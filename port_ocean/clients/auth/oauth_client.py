from pathlib import Path
from port_ocean.clients.auth.auth_client import AuthClient
from port_ocean.context.ocean import ocean
from port_ocean.helpers.retry import register_on_retry_callback


class OAuthClient(AuthClient):
    def __init__(self) -> None:
        """
        A client that can refresh a request using an access token.
        """
        if self.is_oauth_enabled():
            register_on_retry_callback(self.refresh_request_auth_creds)

    def is_oauth_enabled(self) -> bool:
        token_path = ocean.app.config.oauth_access_token_file_path
        # Only consider OAuth enabled when a non-empty file path is configured
        if not isinstance(token_path, str) or token_path == "":
            return False

        return Path(token_path).is_file()

    @property
    def external_access_token(self) -> str:
        access_token = ocean.app.load_external_oauth_access_token()
        if access_token is None:
            raise ValueError("No external access token found")
        return access_token
