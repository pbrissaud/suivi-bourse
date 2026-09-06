"""``mounts.store_persistence``: the one boot-time reading of the store's mount."""

from application import mounts


def test_without_a_linux_mount_table_the_answer_is_unknown(tmp_path):
    assert mounts.store_persistence(tmp_path, mountinfo_path=str(tmp_path / 'absent')) == mounts.UNKNOWN


def test_with_a_mount_table_the_answer_is_one_of_the_two_readings(tmp_path):
    table = tmp_path / 'mountinfo'
    table.write_text('')
    assert mounts.store_persistence(tmp_path, mountinfo_path=str(table)) in (mounts.EPHEMERAL, mounts.PERSISTENT)


def test_a_directory_that_cannot_be_stated_is_unknown(tmp_path):
    table = tmp_path / 'mountinfo'
    table.write_text('')
    assert mounts.store_persistence(tmp_path / 'missing', mountinfo_path=str(table)) == mounts.UNKNOWN
