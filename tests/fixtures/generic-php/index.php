<?php
require_once 'includes/db.php';
include 'includes/header.php';
$result = mysqli_query($conn, "SELECT id, title FROM posts ORDER BY id DESC");
?>
<h1>Latest posts</h1>
<?php while ($row = mysqli_fetch_assoc($result)): ?>
  <a href="post.php?id=<?= $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
<?php endwhile; ?>
<?php include 'includes/footer.php'; ?>
