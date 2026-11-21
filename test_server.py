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


if __name__ == "__main__":
    unittest.main()
