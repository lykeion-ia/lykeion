import io

from lykeion_kernel.protocol import read_messages, write_message


def test_writes_one_object_per_line():
    out = io.StringIO()
    write_message(out, {"id": 1, "result": {"ok": True}})
    write_message(out, {"method": "cell", "params": {}})
    assert out.getvalue() == '{"id": 1, "result": {"ok": true}}\n{"method": "cell", "params": {}}\n'


def test_reads_back_what_was_written():
    stream = io.StringIO('{"id": 1, "method": "host.hello", "params": {}}\n')
    assert list(read_messages(stream)) == [{"id": 1, "method": "host.hello", "params": {}}]


def test_a_line_that_is_not_an_object_is_skipped_rather_than_fatal():
    # A daemon that writes a bad line has a bug; a host that dies on it turns
    # that bug into a machine with no kernels at all.
    stream = io.StringIO('not json\n{"id": 2, "method": "host.hello", "params": {}}\n')
    assert list(read_messages(stream)) == [{"id": 2, "method": "host.hello", "params": {}}]
