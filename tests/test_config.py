"""凭据配置 fail-loud:缺失即报错终止(不带默认值);.env 解析规则。"""
import os

import pytest

import config


class TestGetCredentials:
    def test_missing_credentials_fail_loud(self, monkeypatch):
        # 凭据缺失必须报错终止,绝不带默认值静默继续
        monkeypatch.setattr(config, 'load_dotenv', lambda path=None: None)
        monkeypatch.delenv('HOMARKET_USERNAME', raising=False)
        monkeypatch.delenv('HOMARKET_PASSWORD', raising=False)
        with pytest.raises(config.ConfigError, match='凭据'):
            config.get_credentials()


class TestLoadDotenv:
    def test_parses_quotes_comments_and_env_priority(self, tmp_path, monkeypatch):
        env = tmp_path / '.env'
        env.write_text(
            '# 注释行跳过\n'
            '\n'
            'GOGO_TEST_USER="alice"\n'
            "GOGO_TEST_PASS='s3cret'\n"
            'GOGO_TEST_PRESET=from-file\n'
            'not-a-kv-line\n'
        )
        monkeypatch.setenv('GOGO_TEST_PRESET', 'from-env')
        try:
            config.load_dotenv(env)
            assert os.environ['GOGO_TEST_USER'] == 'alice'      # 双引号剥掉
            assert os.environ['GOGO_TEST_PASS'] == 's3cret'     # 单引号剥掉
            assert os.environ['GOGO_TEST_PRESET'] == 'from-env'  # 已有环境变量优先
        finally:
            os.environ.pop('GOGO_TEST_USER', None)
            os.environ.pop('GOGO_TEST_PASS', None)
