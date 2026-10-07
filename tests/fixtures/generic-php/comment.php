<?php
require_once 'includes/db.php';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $stmt = mysqli_prepare($conn, 'INSERT INTO comments (post_id, body) VALUES (?, ?)');
    mysqli_stmt_bind_param($stmt, 'is', $_POST['post_id'], $_POST['body']);
    mysqli_stmt_execute($stmt);
    header('Location: post.php?id=' . (int) $_POST['post_id']);
    exit;
}
