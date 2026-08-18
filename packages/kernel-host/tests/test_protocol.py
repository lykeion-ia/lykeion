import io

from lykeion_kernel.protocol import is_reply, read_messages, write_message


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


def test_an_answer_is_told_from_a_question_by_its_outcome():
    """One predicate for both directions, because both travel this stream.

    A request from the daemon and an ask from this host both carry an id and
    a method; only an answer carries an outcome. Read off the id instead and
    every request would look like the reply to an ask somebody is waiting on.
    """
    assert is_reply({"id": 1, "result": {"ok": True}})
    assert is_reply({"id": 1, "error": {"message": "no"}})
    assert not is_reply({"id": 1, "method": "host.hello", "params": {}})
    assert not is_reply({"method": "cell", "params": {}})
