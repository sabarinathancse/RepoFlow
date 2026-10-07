<?= $this->extend('layouts/main') ?>
<?= $this->section('content') ?>
<form action="<?= site_url('contact') ?>" method="post">
  <input name="email"><textarea name="message"></textarea>
  <button>Send</button>
</form>
<?= $this->endSection() ?>
