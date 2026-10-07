<?= $this->extend('layouts/main') ?>
<?= $this->section('content') ?>
<h1><?= esc($title) ?></h1>
<?php foreach ($products as $p): ?>
  <a href="<?= base_url('products/' . $p['slug']) ?>"><?= esc($p['name']) ?></a>
<?php endforeach ?>
<?= $this->endSection() ?>
