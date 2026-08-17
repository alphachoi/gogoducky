"""凭据与运行配置。凭据只从环境变量读取,绝不硬编码。"""
import os
from pathlib import Path


class ConfigError(Exception):
    pass


def load_dotenv(path=None):
    """加载 .env 文件到环境变量(已存在的环境变量优先)。"""
    env_path = Path(path) if path else Path(__file__).parent / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get_credentials():
    """返回 (username, password),缺失即报错终止——不带默认值。"""
    load_dotenv()
    username = os.environ.get('HOMARKET_USERNAME')
    password = os.environ.get('HOMARKET_PASSWORD')
    if not username or not password:
        raise ConfigError(
            '缺少凭据:请设置 HOMARKET_USERNAME / HOMARKET_PASSWORD 环境变量,'
            '或复制 .env.example 为 .env 后填写。'
        )
    return username, password
