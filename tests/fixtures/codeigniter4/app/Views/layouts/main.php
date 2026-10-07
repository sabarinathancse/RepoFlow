<!doctype html>
<html><head><title><?= esc($title ?? 'Shop') ?></title></head>
<body>
<nav><a href="<?= base_url('/') ?>">Home</a> <a href="<?= site_url('contact') ?>">Contact</a></nav>
<?= $this->renderSection('content') ?>
<script src="<?= base_url('assets/js/app.js') ?>"></script>
</body></html>
