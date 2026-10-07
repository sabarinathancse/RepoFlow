<?= $this->extend('layouts/main') ?>
<?= $this->section('content') ?>
<form action="<?= base_url('admin/products/store') ?>" method="post" enctype="multipart/form-data">
  <?= csrf_field() ?><input type="file" name="image"><button>Save</button>
</form>
<?php foreach ($products as $p): ?>
  <a href="<?= base_url('admin/products/delete/' . $p['id']) ?>" onclick="return confirm('Delete?')">Delete</a>
<?php endforeach ?>
<script>
const EXPORT_URL = '<?= base_url("admin/products/export") ?>';
fetch(EXPORT_URL).then(r => r.json());
$.ajax({ url: '<?= base_url("admin/reports") ?>', type: 'GET' });
</script>
<?= $this->endSection() ?>
