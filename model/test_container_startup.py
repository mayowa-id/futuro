import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('container_startup', Path(__file__).resolve().parent.parent / 'docker' / 'entrypoint.py')
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class ContainerStartupTests(unittest.TestCase):
    def setUp(self):
        startup.STOPPING = False

    def test_missing_access_token_starts_no_child_process(self):
        with patch.dict(startup.os.environ, {'API_ACCESS_TOKEN': ''}), patch.object(startup.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'API_ACCESS_TOKEN'):
                startup.main()
            launch.assert_not_called()

    def test_api_process_failure_shuts_down_the_private_scorer(self):
        model = MagicMock()
        model.poll.return_value = None
        api = MagicMock()
        api.poll.return_value = 1
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.dict(startup.os.environ, {'API_ACCESS_TOKEN': 'test-only'}), \
             patch.object(startup.signal, 'signal'), \
             patch.object(startup.subprocess, 'Popen', side_effect=[model, api]) as launch, \
             patch.object(startup.urllib.request, 'urlopen', return_value=response), \
             patch.object(startup, 'stop_process') as stop:
            with self.assertRaisesRegex(RuntimeError, 'required application process exited'):
                startup.main()
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(stop.call_args_list[0].args, (api,))
            self.assertEqual(stop.call_args_list[1].args, (model,))


if __name__ == '__main__':
    unittest.main()
