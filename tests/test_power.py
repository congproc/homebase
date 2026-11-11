import importlib.machinery
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

loader=importlib.machinery.SourceFileLoader('power',str(pathlib.Path(__file__).resolve().parents[1]/'system/homebase-power'))
spec=importlib.util.spec_from_loader(loader.name,loader)
power=importlib.util.module_from_spec(spec)
loader.exec_module(power)

class PowerPolicyTest(unittest.TestCase):
    def config(self):
        return {**power.DEFAULT,'services':{'user:finance.service':True,'user:homebase.service':False}}

    def test_valid_schedule(self):
        self.assertEqual(power.validate(self.config())['sleepTime'],'00:30')

    def test_reject_unsafe_fields(self):
        for field,value in [('sleepTime','01:30\nExecStart=/bin/sh'),('wakeTime','25:00'),('enabled','true'),('services',{'system:../../oops.service':True}),('services',{'user:finance.service':'yes'})]:
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                power.validate({**self.config(),field:value})
        with self.assertRaises(ValueError):
            power.validate({**self.config(),'extra':'x'})

    def test_equal_sleep_and_wake_rejected(self):
        with self.assertRaises(ValueError):power.validate({**self.config(),'wakeTime':'00:30'})

    def test_only_selected_running_services_block(self):
        with patch.object(power,'systemctl',return_value=SimpleNamespace(returncode=0,stdout='active\n')) as call:
            blockers=power.service_blockers(self.config())
            self.assertEqual(len(blockers),1)
            self.assertIn('finance.service',blockers[0])
            self.assertEqual(call.call_count,1)

    def test_selected_inactive_service_allows_sleep(self):
        with patch.object(power,'systemctl',return_value=SimpleNamespace(returncode=0,stdout='inactive\n')):
            self.assertEqual(power.service_blockers(self.config()),[])

    def test_unknown_service_state_fails_closed(self):
        with patch.object(power,'systemctl',return_value=SimpleNamespace(returncode=1,stdout='')):
            self.assertIn('Unable to check',power.service_blockers(self.config())[0])

    def test_atomic_config_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'power.json'
            power.atomic_write(path,json.dumps(self.config()))
            self.assertEqual(json.loads(path.read_text()),self.config())
            self.assertEqual(path.stat().st_mode&0o777,0o644)
            self.assertEqual(len(list(path.parent.iterdir())),1)

    def test_apply_updates_timer_and_persists_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            config=pathlib.Path(directory)/'power.json'
            dropin=pathlib.Path(directory)/'timer.conf'
            lock=pathlib.Path(directory)/'lock'
            with patch.object(power,'CONFIG',config),patch.object(power,'DROPIN',dropin),patch.object(power,'LOCK',lock),patch.object(power.os,'geteuid',return_value=0),patch.object(power,'systemctl',side_effect=lambda *args: SimpleNamespace(returncode=0,stdout='enabled' if args[1]=='is-enabled' else 'loaded')),patch.object(power,'run') as run:
                wanted={**self.config(),'sleepTime':'01:30'}
                self.assertEqual(power.apply(wanted),wanted)
                self.assertIn('OnCalendar=*-*-* 01:30:00',dropin.read_text())
                self.assertEqual(json.loads(config.read_text()),wanted)
                self.assertTrue(any('restart' in call.args[0] for call in run.call_args_list))

    def test_apply_failure_rolls_back_files(self):
        with tempfile.TemporaryDirectory() as directory:
            config=pathlib.Path(directory)/'power.json'
            dropin=pathlib.Path(directory)/'timer.conf'
            lock=pathlib.Path(directory)/'lock'
            original=json.dumps(self.config())
            config.write_text(original)
            dropin.write_text('original timer')
            def fail_checked(args,check=True):
                if check:raise RuntimeError('systemctl failed')
                return SimpleNamespace(returncode=0,stdout='')
            with patch.object(power,'CONFIG',config),patch.object(power,'DROPIN',dropin),patch.object(power,'LOCK',lock),patch.object(power.os,'geteuid',return_value=0),patch.object(power,'systemctl',return_value=SimpleNamespace(returncode=0,stdout='loaded')),patch.object(power,'run',side_effect=fail_checked):
                with self.assertRaises(RuntimeError):power.apply(self.config())
                self.assertEqual(config.read_text(),original)
                self.assertEqual(dropin.read_text(),'original timer')

    def test_apply_requires_root(self):
        with patch.object(power.os,'geteuid',return_value=1000),self.assertRaises(ValueError):
            power.apply(self.config())

if __name__=='__main__':unittest.main()

class ServiceControlTest(unittest.TestCase):
    def setUp(self):
        self.dir=tempfile.TemporaryDirectory()
        self.units=pathlib.Path(self.dir.name)
        (self.units/'ollama.service').write_text('[Service]\n')
        (self.units/'linked.service').symlink_to(self.units/'ollama.service')
        self.patch=patch.object(power,'SYSTEM_UNITS',self.units)
        self.patch.start()
    def tearDown(self):
        self.patch.stop();self.dir.cleanup()

    def test_rejects_bad_names_actions_and_symlinks(self):
        for action,unit in [('kill','ollama.service'),('stop','../passwd'),('stop','server-night-sleep.service'),('stop','missing.service'),('stop','linked.service'),('stop','a b.service')]:
            with self.assertRaises(ValueError):
                power.control_service(action,unit)

    def test_runs_systemctl_with_argument_list(self):
        with patch.object(power.os,'geteuid',return_value=0),patch.object(power.subprocess,'run',return_value=SimpleNamespace(returncode=0,stderr='')) as run:
            self.assertEqual(power.control_service('stop','ollama.service'),0)
        self.assertEqual(run.call_args.args[0],['/usr/bin/systemctl','stop','--','ollama.service'])

    def test_requires_root(self):
        with patch.object(power.os,'geteuid',return_value=1000),self.assertRaises(ValueError):
            power.control_service('start','ollama.service')


class LockAndNameHardeningTest(unittest.TestCase):
    def test_lock_refuses_symlink_and_shared_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            lock=pathlib.Path(directory)/'lock'
            target=pathlib.Path(directory)/'target'; target.write_text('')
            lock.symlink_to(target)
            with patch.object(power,'LOCK',lock),self.assertRaises(OSError):
                power.acquire_lock(timeout=0.1)
            lock.unlink(); lock.write_text(''); lock.chmod(0o644)
            with patch.object(power,'LOCK',lock),self.assertRaises(ValueError):
                power.acquire_lock(timeout=0.1)

    def test_lock_contention_times_out_instead_of_hanging(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            lock=pathlib.Path(directory)/'lock'
            with patch.object(power,'LOCK',lock):
                held=power.acquire_lock(timeout=0.1)
                try:
                    other=os.open(lock,os.O_RDONLY);fcntl.flock(other,fcntl.LOCK_UN);os.close(other)
                    with self.assertRaises(ValueError):
                        # a second, independent open must not get the lock while it is held
                        power.acquire_lock(timeout=0.3)
                finally:
                    held.close()

    def test_unit_names_cannot_start_with_option_dash(self):
        for key in ('system:-Hroot@x.service','user:-x.service','system:a@b.service'):
            config={'enabled':True,'sleepTime':'00:30','wakeTime':'05:00','blockSsh':True,'blockTmux':True,'services':{key:True}}
            with self.assertRaises(ValueError):
                power.validate(config)
        with self.assertRaises(ValueError):
            power.control_service('stop','-Hx.service')
        with self.assertRaises(ValueError):
            power.control_service('stop','snap.thing.service')

    def test_smart_rejects_unknown_or_unsafe_disk_names(self):
        for name in ('-a', 'sda1', '../sda', 'sda;id', 'nvme0', 'dm-0', 'loop0', ''):
            with self.subTest(name=name), self.assertRaises(ValueError):
                power.smart(name)

    def test_smart_summary_keeps_only_known_fields(self):
        data={'smart_status':{'passed':True},'temperature':{'current':41},'power_on_time':{'hours':1234},'serial_number':'hidden',
              'nvme_smart_health_information_log':{'percentage_used':2,'media_errors':0,'unrelated':1},
              'ata_smart_attributes':{'table':[{'id':5,'name':'Reallocated_Sector_Ct','value':100,'worst':100,'thresh':10,'raw':{'value':0},'when_failed':''},{'id':1,'name':'Raw_Read_Error_Rate','raw':{'value':9}}]}}
        out=power.smart_summary(data)
        self.assertEqual(out['passed'],True)
        self.assertEqual(out['powerOnHours'],1234)
        self.assertEqual(out['nvme'],{'percentage_used':2,'media_errors':0})
        self.assertEqual([a['id'] for a in out['ata']],[5])
        self.assertIsNone(out['ata'][0]['failing'])
        self.assertNotIn('serial_number',json.dumps(out))

    def test_smart_standby_and_missing_tool(self):
        with patch.object(power.pathlib.Path,'is_dir',return_value=True):
            with patch.object(power,'SMARTCTL',('/nonexistent/smartctl',)):
                self.assertEqual(power.smart('sda'),{'error':'not-installed'})
            with patch.object(power,'SMARTCTL',(__file__,)),patch.object(power.os,'geteuid',return_value=0),\
                 patch.object(power.subprocess,'run',return_value=SimpleNamespace(returncode=power.STANDBY,stdout='')) as run:
                self.assertEqual(power.smart('nvme0n1'),{'standby':True})
                self.assertEqual(run.call_args[0][0][-1],'/dev/nvme0n1')

class DesktopTest(unittest.TestCase):
    loaded = SimpleNamespace(returncode=0, stdout='loaded\n')

    def test_rejects_unknown_actions_and_non_root(self):
        for action in ('', 'restart', 'on;reboot', 'ON'):
            with self.subTest(action=action), self.assertRaises(ValueError):
                power.desktop(action)
        with patch.object(power.os, 'geteuid', return_value=1000), self.assertRaises(ValueError):
            power.desktop('off')

    def test_refuses_without_display_manager(self):
        with patch.object(power.os, 'geteuid', return_value=0), \
             patch.object(power, 'systemctl', return_value=SimpleNamespace(returncode=0, stdout='not-found\n')), \
             patch.object(power.subprocess, 'run') as run, self.assertRaises(ValueError):
            power.desktop('off')
        run.assert_not_called()

    def test_off_sets_text_boot_then_stops_display_manager(self):
        with patch.object(power.os, 'geteuid', return_value=0), patch.object(power, 'systemctl', return_value=self.loaded), \
             patch.object(power.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stderr='')) as run:
            self.assertEqual(power.desktop('off'), 0)
        self.assertEqual([c[0][0] for c in run.call_args_list],
                         [['/usr/bin/systemctl', 'set-default', 'multi-user.target'], ['/usr/bin/systemctl', 'stop', 'display-manager.service']])

    def test_on_sets_graphical_boot_then_starts_it(self):
        with patch.object(power.os, 'geteuid', return_value=0), patch.object(power, 'systemctl', return_value=self.loaded), \
             patch.object(power.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stderr='')) as run:
            power.desktop('on')
        self.assertEqual([c[0][0] for c in run.call_args_list],
                         [['/usr/bin/systemctl', 'set-default', 'graphical.target'], ['/usr/bin/systemctl', 'start', 'graphical.target']])

    def test_failure_is_reported(self):
        with patch.object(power.os, 'geteuid', return_value=0), patch.object(power, 'systemctl', return_value=self.loaded), \
             patch.object(power.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr='Job failed')), \
             self.assertRaisesRegex(ValueError, 'Job failed'):
            power.desktop('on')


class SudoersTest(unittest.TestCase):
    def test_desktop_rule_allows_only_on_and_off(self):
        loader = importlib.machinery.SourceFileLoader('installer', str(pathlib.Path(__file__).resolve().parents[1] / 'system/install-power.py'))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        installer = importlib.util.module_from_spec(spec)
        loader.exec_module(installer)
        rules = [l for l in installer.sudoers_for('alice').splitlines() if 'desktop' in l and not l.startswith('#')]
        self.assertEqual(rules, ['alice ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power desktop on',
                                 'alice ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power desktop off'])
