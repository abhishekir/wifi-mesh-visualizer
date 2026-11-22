import sys
import unittest
from unittest import mock

# CoreWLAN only exists on macOS; these tests cover pure parsing.
sys.modules.setdefault("CoreWLAN", mock.MagicMock())
import server  # noqa: E402


def ping_output(replies, sent):
    lines = [f"64 bytes from 192.168.1.1: icmp_seq={seq} ttl=64 time={ms} ms"
             for seq, ms in replies]
    lines.append(f"{sent} packets transmitted, {len(replies)} packets received")
    return "\n".join(lines)


class ParsePingTest(unittest.TestCase):
    def test_interrupted_run_drops_echo_in_flight(self):
        out = ping_output([(seq, 4.0) for seq in range(10)], sent=11)
        stats = server.ping_stats(server.parse_ping(out, interrupted_every=0.2))
        self.assertEqual((stats["sent"], stats["lossPct"]), (10, 0.0))

    def test_burst_keeps_loss_after_last_reply(self):
        out = ping_output([(seq, 4.0) for seq in range(5)], sent=10)
        stats = server.ping_stats(server.parse_ping(out))
        self.assertEqual((stats["sent"], stats["lossPct"]), (10, 50.0))

    def test_interrupted_run_keeps_loss_before_in_flight_window(self):
        # Link drops mid-phase: only the last 2 sends could be in flight.
        out = ping_output([(seq, 4.0) for seq in range(5)], sent=30)
        stats = server.ping_stats(server.parse_ping(out, interrupted_every=0.2))
        self.assertEqual((stats["sent"], stats["lossPct"]), (28, 82.1))

    def test_no_statistics(self):
        self.assertIsNone(server.parse_ping("ping: cannot resolve host"))


NETSTAT = """\
Name  Mtu   Network     Address            Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
en0   1500  <Link#15>   f2:e9:18:eb:29:ea  100   0     {rx}   80    0     {tx}   0
en0   1500  192.168.86  192.168.86.75      100   -     {rx}   80    -     {tx}   -
"""


class WifiThroughputTest(unittest.TestCase):
    def setUp(self):
        server._throughput_sample = server._throughput = None

    def sample(self, at, rx, tx, stdout=None):
        stdout = NETSTAT.format(rx=rx, tx=tx) if stdout is None else stdout
        self.run = mock.Mock(return_value=mock.Mock(stdout=stdout))
        with mock.patch.object(server.subprocess, "run", self.run), \
                mock.patch.object(server.time, "monotonic", return_value=at):
            return server.wifi_throughput()

    def test_failed_sample_stays_rate_limited(self):
        header_only = NETSTAT.splitlines()[0]  # netstat -I "" exits 0 like this
        self.assertIsNone(self.sample(100.0, 0, 0, stdout=header_only))
        self.assertIsNone(self.sample(100.5, 0, 0))
        self.run.assert_not_called()
        self.assertIsNone(self.sample(101.0, 0, 0))  # no rate from a failed read
        self.assertIsNotNone(self.sample(102.0, 1000, 1000))

    def test_parses_link_row(self):
        self.assertEqual(server.parse_netstat_bytes(NETSTAT.format(rx=5, tx=7)), (5, 7))

    def test_rate_from_counter_deltas(self):
        self.assertIsNone(self.sample(100.0, 0, 0))
        self.assertEqual(self.sample(102.0, 25_000_000, 2_500_000),
                         {"downMbps": 100.0, "upMbps": 10.0})

    def test_long_gap_and_counter_reset_give_no_rate(self):
        self.sample(100.0, 1000, 1000)
        self.assertIsNone(self.sample(200.0, 2000, 2000))  # gap
        self.assertIsNone(self.sample(201.0, 0, 0))        # reset


if __name__ == "__main__":
    unittest.main()
